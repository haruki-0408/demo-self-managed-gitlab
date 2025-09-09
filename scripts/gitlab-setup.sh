#!/bin/bash
set -e

# GitLab CE Self-Managed 自動セットアップスクリプト (公式方式)
# 変数置換により値が設定されます

DOMAIN_NAME="${DOMAIN_NAME}"
EMAIL="${EMAIL}"
SECRET_ARN="${SECRET_ARN}"
LOG_GROUP_NAME="${LOG_GROUP_NAME}"

echo "Starting GitLab CE self-managed setup for domain: $DOMAIN_NAME"

# システムアップデートと基本依存関係のインストール
dnf update -y
dnf install -y policycoreutils-python-utils openssh-server openssh-clients perl wget

# curl-minimalが既にインストールされているので、curlは不要

# CloudWatch Agentのインストール
echo "Installing CloudWatch Agent..."
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm -O /tmp/amazon-cloudwatch-agent.rpm
rpm -U /tmp/amazon-cloudwatch-agent.rpm

# メール機能は必要に応じて後で設定（Postfixインストールをスキップ）

# GitLab公式リポジトリを追加
curl "https://packages.gitlab.com/install/repositories/gitlab/gitlab-ce/script.rpm.sh" | sudo bash

# GitLab CEをインストール（HTTP設定 - ALB経由でHTTPS終端）
echo "Installing GitLab CE with domain: $DOMAIN_NAME"
EXTERNAL_URL="http://${DOMAIN_NAME}" dnf install -y gitlab-ce

# GitLabの初期設定完了を待機
echo "Waiting for GitLab to be ready..."
until gitlab-ctl status > /dev/null 2>&1; do
  echo "GitLab services starting..."
  sleep 10
done

# GitLabのWebサービス起動を待機
until curl -f http://localhost/-/health > /dev/null 2>&1; do
  echo "Waiting for GitLab web service..."
  sleep 30
done

# GitLabの初期rootパスワードを取得
echo "Getting GitLab root password..."
if [ -f "/etc/gitlab/initial_root_password" ]; then
  ROOT_PASSWORD=$(grep 'Password:' /etc/gitlab/initial_root_password | awk '{print $2}')
else
  # バックアップ用のパスワード生成
  ROOT_PASSWORD="GitLab$(openssl rand -base64 16 | tr -d '=+/')"
  echo "Generated backup password: $ROOT_PASSWORD"
fi

# Secrets Managerにパスワードを保存
aws secretsmanager put-secret-value --secret-id "${SECRET_ARN}" --secret-string "{\"username\":\"root\",\"password\":\"$ROOT_PASSWORD\"}" --region $(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# GitLab設定をALB+HTTPS終端用に調整
echo "Configuring GitLab for ALB with HTTPS termination..."
cat >> /etc/gitlab/gitlab.rb << EOL

# ALB経由のHTTPS終端設定
external_url 'https://${DOMAIN_NAME}'  # ユーザー向けURLはHTTPS
nginx['listen_port'] = 80              # 内部リスンはHTTP
nginx['listen_https'] = false          # HTTPS終端はALBが処理
gitlab_rails['trusted_proxies'] = ['10.0.0.0/8']  # ALBのプライベートIP帯を信頼

# Let's Encryptを明示的に無効化（GitLab 10.7以降でhttps URLの場合デフォルト有効のため）
letsencrypt['enable'] = false
EOL

# GitLab設定を再構成（ALB+Certificate Manager構成で動作）
gitlab-ctl reconfigure

# CloudWatch Agent設定ファイルの作成
echo "Configuring CloudWatch Agent..."
cat > /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json << EOL
{
  "logs": {
    "logs_collected": {
      "files": {
        "collect_list": [
          {
            "file_path": "/var/log/gitlab/gitlab-rails/production.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "gitlab-rails-production",
            "timezone": "UTC",
            "multi_line_start_pattern": "{timestamp_regex}"
          },
          {
            "file_path": "/var/log/gitlab/gitlab-rails/application.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "gitlab-rails-application", 
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/nginx/gitlab_access.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "nginx-access",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/nginx/gitlab_error.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "nginx-error",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/sidekiq/current",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "sidekiq",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/gitlab-workhorse/current",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "gitlab-workhorse",
            "timezone": "UTC"
          }
        ]
      }
    }
  }
}
EOL

# CloudWatch Agentの起動
echo "Starting CloudWatch Agent..."
/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json -s
systemctl enable amazon-cloudwatch-agent
systemctl start amazon-cloudwatch-agent

# GitLabのHTTP対応完了を最終確認
echo "Waiting for GitLab HTTP to be ready..."
until curl -f http://localhost/users/sign_in > /dev/null 2>&1; do
  echo "GitLab HTTP is not ready yet, waiting..."
  sleep 30
done

echo "GitLab CE self-managed setup completed successfully!"
echo "Domain: ${DOMAIN_NAME}"
echo "Access URL: https://${DOMAIN_NAME} (via ALB with HTTPS termination)"
echo "Root password stored in AWS Secrets Manager: ${SECRET_ARN}"
echo "GitLab admin login: root / (password from Secrets Manager)"