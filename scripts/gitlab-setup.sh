#!/bin/bash
set -e

# システムアップデートと基本依存関係のインストール
dnf update -y
dnf install -y policycoreutils-python-utils openssh-server openssh-clients perl wget

# GitLab公式リポジトリを追加
curl "https://packages.gitlab.com/install/repositories/gitlab/gitlab-ce/script.rpm.sh" | bash

# GitLab CEをインストール
dnf install -y gitlab-ce

# GitLab設定ファイルに追記
cat >> /etc/gitlab/gitlab.rb << EOF

# GitLab基本設定
external_url 'http://${DOMAIN_NAME}'
nginx['listen_port'] = 80
nginx['listen_https'] = false

# AWS EC2 UserData環境でのsystemdターゲット競合を回避
package['systemd_after'] = 'basic.target'
package['systemd_wanted_by'] = 'basic.target'
EOF

# GitLab設定を適用
gitlab-ctl reconfigure

# GitLabの初期rootパスワードを取得してSecrets Managerに保存
if [ -f "/etc/gitlab/initial_root_password" ]; then
  ROOT_PASSWORD=$(grep '^Password:' /etc/gitlab/initial_root_password | sed 's/^Password: //')
  if [ -n "$ROOT_PASSWORD" ]; then
    aws secretsmanager put-secret-value --secret-id "${SECRET_ARN}" --secret-string "{\"username\":\"root\",\"password\":\"$ROOT_PASSWORD\"}" --region "ap-northeast-1"
  fi
fi