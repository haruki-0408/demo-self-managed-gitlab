# CloudWatch Agent 設定確認手順

## 1. CloudWatch Agent 状態確認

```bash
# サービス状態確認
systemctl status amazon-cloudwatch-agent

# プロセス確認
ps aux | grep cloudwatch

# エージェント状態確認
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a status
```

## 2. 設定ファイル確認

```bash
# 設定ファイル一覧
ls -la /opt/aws/amazon-cloudwatch-agent/etc/

# ユーザーデータで作成された設定ファイル確認
sudo cat /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/file_*.json

# 有効な設定ファイル確認（TOMLフォーマット）
sudo cat /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.toml
```

## 3. GitLabログファイル存在確認

```bash
# GitLabログディレクトリ全体確認
sudo find /var/log/gitlab -type f | head -10

# 設定で指定されているログファイルの存在確認
sudo ls -la /var/log/gitlab/gitlab-rails/ 2>/dev/null || echo "gitlab-rails directory not found"
sudo ls -la /var/log/gitlab/nginx/ 2>/dev/null || echo "nginx directory not found"
sudo ls -la /var/log/gitlab/sidekiq/ 2>/dev/null || echo "sidekiq directory not found"
sudo ls -la /var/log/gitlab/gitlab-workhorse/ 2>/dev/null || echo "gitlab-workhorse directory not found"

# GitLabサービス状態確認（ログファイルが存在しない場合）
sudo gitlab-ctl status
```

## 4. CloudWatch Agent ログ確認

```bash
# CloudWatch Agent 動作ログ
sudo tail -50 /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log

# システムログでのエラー確認
sudo journalctl -u amazon-cloudwatch-agent -n 20

# 設定適用時のログ確認
sudo journalctl -u amazon-cloudwatch-agent --since "1 hour ago"
```

## 5. IAM権限確認

```bash
# インスタンスプロファイル確認
curl http://169.254.169.254/latest/meta-data/iam/security-credentials/

# CloudWatch権限テスト
aws logs describe-log-groups --region ap-northeast-1

# ログストリーム確認
aws logs describe-log-streams --log-group-name "/aws/ec2/gitlab/asanoharuki.classmethod.info" --region ap-northeast-1
```

## 6. 手動でのログ送信テスト

```bash
# テストログエントリの作成
echo "Test log entry $(date)" | sudo tee -a /var/log/gitlab/nginx/access.log

# CloudWatch Agent 再起動
sudo systemctl restart amazon-cloudwatch-agent

# 数分後にCloudWatchコンソールでログ確認
```

## 7. トラブルシューティング

### 問題1: GitLabログファイルが存在しない場合
```bash
# GitLabサービス確認
sudo gitlab-ctl status

# GitLab再設定（ログディレクトリとファイルを作成）
sudo gitlab-ctl reconfigure

# GitLabサービス再起動
sudo gitlab-ctl restart

# ログディレクトリ再確認
sudo find /var/log/gitlab -type d
sudo find /var/log/gitlab -name "*.log"
```

### 問題2: CloudWatch Agent設定再適用
```bash
# 設定再適用（正しいファイルパス使用）
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/file_amazon-cloudwatch-agent.json -s

# サービス再起動
sudo systemctl restart amazon-cloudwatch-agent

# 設定確認
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -m ec2 -a status
```

### 問題3: CloudWatch Agent がログファイルを認識していない場合
```bash
# ファイル権限確認
sudo ls -la /var/log/gitlab/nginx/access.log
sudo ls -la /var/log/gitlab/gitlab-rails/production.log

# ファイル作成権限確認（cwagentユーザー）
sudo -u cwagent ls -la /var/log/gitlab/ || echo "Permission denied for cwagent user"

# ログファイルの権限修正（必要に応じて）
sudo chown -R git:git /var/log/gitlab/
sudo chmod -R 644 /var/log/gitlab/**/*.log
```