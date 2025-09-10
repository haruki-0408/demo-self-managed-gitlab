#!/bin/bash
set -e

# GitLab CE Self-Managed 自動セットアップスクリプト
# 変数置換により値が設定されます

DOMAIN_NAME="${DOMAIN_NAME}"
EMAIL="${EMAIL}"
SECRET_ARN="${SECRET_ARN}"
LOG_GROUP_NAME="${LOG_GROUP_NAME}"

echo "Starting GitLab CE self-managed setup for domain: $DOMAIN_NAME"

# システムアップデートと基本依存関係のインストール
dnf update -y
dnf install -y policycoreutils-python-utils openssh-server openssh-clients perl wget

# CloudWatch Agentのインストールと設定
echo "Installing and configuring CloudWatch Agent..."
wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm -O /tmp/amazon-cloudwatch-agent.rpm
rpm -U /tmp/amazon-cloudwatch-agent.rpm

# CloudWatch Agent設定ファイルの作成
echo "Creating CloudWatch Agent configuration..."
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
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/gitlab-rails/application.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "gitlab-rails-application", 
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/nginx/access.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "nginx-access",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/gitlab/nginx/error.log",
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
          },
          {
            "file_path": "/var/log/shell-activity/commands.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "shell-commands",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/shell-activity/output.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "shell-output",
            "timezone": "UTC"
          },
          {
            "file_path": "/var/log/shell-activity/error.log",
            "log_group_name": "${LOG_GROUP_NAME}",
            "log_stream_name": "shell-errors",
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

# すべてのシェル操作をログに記録する設定
echo "Setting up shell logging..."
mkdir -p /var/log/shell-activity

# bashrcに全コマンド記録設定を追加
cat >> /etc/bashrc << 'SHELLLOG'

# 全コマンド実行をログファイルに記録
export PROMPT_COMMAND='echo "$(date "+%Y-%m-%d %H:%M:%S") [$(whoami)@$(hostname):$(pwd)] $(history 1 | sed "s/^ *[0-9]* *//")" >> /var/log/shell-activity/commands.log'
export HISTTIMEFORMAT="%Y-%m-%d %H:%M:%S "
export HISTSIZE=10000
export HISTFILESIZE=10000
shopt -s histappend

# コマンド出力もキャプチャする関数
exec > >(tee -a /var/log/shell-activity/output.log)
exec 2> >(tee -a /var/log/shell-activity/error.log >&2)
SHELLLOG

# ログファイルの権限設定
touch /var/log/shell-activity/commands.log
touch /var/log/shell-activity/output.log  
touch /var/log/shell-activity/error.log
chmod 644 /var/log/shell-activity/*.log

# GitLab公式リポジトリを追加
curl "https://packages.gitlab.com/install/repositories/gitlab/gitlab-ce/script.rpm.sh" | bash

# GitLab CEをインストール
echo "Installing GitLab CE with domain: $DOMAIN_NAME"
EXTERNAL_URL="http://${DOMAIN_NAME}" dnf install -y gitlab-ce

# GitLab post-installプロセスの完了を待機
echo "Waiting for GitLab post-install process to complete..."
while pgrep -f "gitlab-ctl upgrade\|cinc-client" > /dev/null; do
  echo "GitLab post-install process still running..."
  sleep 30
done

# GitLabの初期設定を実行
echo "Configuring GitLab..."
gitlab-ctl reconfigure

# GitLabサービスの起動完了を待機
echo "Waiting for GitLab services to start..."
until gitlab-ctl status > /dev/null 2>&1; do
  echo "GitLab services starting..."
  sleep 10
done

# GitLabのWebサービス起動を待機
echo "Waiting for GitLab web service..."
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
external_url 'https://${DOMAIN_NAME}'
nginx['listen_port'] = 80
nginx['listen_https'] = false

# ALBからのHTTPSプロキシヘッダー設定
nginx['proxy_set_headers'] = {
  'X-Forwarded-Proto' => 'https',
  'X-Forwarded-Ssl' => 'on'
}

# Let's Encryptを無効化
letsencrypt['enable'] = false
EOL

# GitLab設定を再構成
gitlab-ctl reconfigure

# GitLabのHTTP対応完了を最終確認
echo "Final GitLab HTTP readiness check..."
until curl -f http://localhost/users/sign_in > /dev/null 2>&1; do
  echo "GitLab HTTP is not ready yet, waiting..."
  sleep 30
done

echo "GitLab CE self-managed setup completed successfully!"
echo "Domain: ${DOMAIN_NAME}"
echo "Access URL: https://${DOMAIN_NAME}"
echo "Root password stored in AWS Secrets Manager: ${SECRET_ARN}"