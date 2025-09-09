# Self-Managed GitLab on AWS with CDK

この CDK プロジェクトは、AWS 上に self-managed GitLab 環境を一発で構築します。

## 🚀 機能

- **EC2 インスタンス**: GitLab CE を Docker で実行
- **自動 HTTPS 化**: Let's Encrypt による SSL/TLS 証明書の自動取得・更新
- **Secrets Manager**: GitLab root パスワードの安全な管理
- **Route53**: 独自ドメインでの DNS 設定（オプション）
- **VPC**: セキュリティを考慮したネットワーク構成

## 📋 前提条件

1. **AWS CLI** の設定完了
2. **Node.js** (v18以上) がインストール済み
3. **独自ドメイン** の準備
4. **Route53 ホストゾーン**（オプション - DNS 自動設定を使う場合）

## 🛠 セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. CDK Bootstrap（初回のみ）

```bash
npx cdk bootstrap
```

## 🚀 デプロイ

### 方法1: parameters.ts ファイルで設定（推奨）

1. `parameters.ts` を編集
   ```typescript
   export const parameters: GitLabParameters = {
     domainName: 'gitlab.yourdomain.com',     // 実際のドメイン名に変更
     email: 'admin@yourdomain.com',           // 実際のメールアドレスに変更
     hostedZoneId: 'Z1234567890ABC',          // Route53使用時のみ
   };
   ```

2. デプロイ実行
   ```bash
   npx cdk deploy
   ```

### 方法2: コマンドライン引数で実行

```bash
npx cdk deploy \
  -c domainName=gitlab.yourdomain.com \
  -c email=admin@yourdomain.com \
  -c hostedZoneId=Z1234567890ABC \
  -c keyPairName=my-keypair
```

### 方法3: 環境変数で実行

```bash
export GITLAB_DOMAIN=gitlab.yourdomain.com
export GITLAB_EMAIL=admin@yourdomain.com
export HOSTED_ZONE_ID=Z1234567890ABC  # オプション
export KEY_PAIR_NAME=my-keypair        # オプション

npx cdk deploy
```

### パラメータ優先順位

1. CDK Context (`-c` オプション)
2. 環境変数
3. `parameters.ts` ファイル

## 📝 パラメータ説明

| パラメータ | 必須 | 説明 | 例 |
|-----------|------|------|-----|
| `domainName` | ✅ | GitLab のドメイン名 | `gitlab.example.com` |
| `email` | ✅ | Let's Encrypt の証明書用メールアドレス | `admin@example.com` |
| `hostedZoneId` | ❌ | Route53 ホストゾーン ID | `Z1234567890ABC` |
| `keyPairName` | ❌ | EC2 SSH キーペア名 | `my-keypair` |

## ⏱ デプロイ完了後

デプロイには約 **10-15分** かかります。完了後：

1. **GitLab URL**: `https://gitlab.yourdomain.com` でアクセス可能
2. **Root パスワード**: AWS Secrets Manager に自動保存
3. **SSL/TLS証明書**: Let's Encrypt により自動取得・90日ごとに自動更新

### GitLab にログイン

```bash
# Secrets Manager からパスワードを取得
aws secretsmanager get-secret-value --secret-id gitlab-root-password --query 'SecretString' --output text

# または、EC2 インスタンスに SSM でアクセス
aws ssm start-session --target i-1234567890abcdef0
```

## 🔧 Route53 設定（手動）

`hostedZoneId` を指定しない場合は、手動で DNS 設定：

1. デプロイ完了後の **出力値** から EC2 の **パブリック IP** を確認
2. お使いの DNS プロバイダーで **A レコード** を設定
   ```
   gitlab.yourdomain.com → 203.0.113.123
   ```

## 📊 出力値

デプロイ完了後、以下の情報が出力されます：

- **GitLabURL**: GitLab のアクセス URL
- **GitLabInstanceId**: EC2 インスタンス ID
- **GitLabSecretArn**: Secrets Manager の ARN
- **SSHCommand**: SSM 経由の SSH コマンド

## 🔒 セキュリティ

- **セキュリティグループ**: HTTP(80), HTTPS(443), SSH(22) のみ許可
- **IAM ロール**: 最小権限の原則
- **Secrets Manager**: パスワードの暗号化保存
- **Let's Encrypt**: 自動 SSL/TLS 証明書管理

## 🔄 メンテナンス

### SSL 証明書の更新

自動で90日ごとに更新されますが、手動実行も可能：

```bash
# EC2 インスタンスにアクセス
aws ssm start-session --target i-1234567890abcdef0

# 手動更新
sudo /opt/bitnami/letsencrypt/lego --tls --email="admin@example.com" --domains="gitlab.example.com" --path="/opt/bitnami/letsencrypt" renew
```

### GitLab のバックアップ

```bash
# GitLab コンテナでバックアップ実行
docker exec gitlab gitlab-backup create
```

## 🗑 削除

```bash
npx cdk destroy
```

## ⚠️ 注意事項

- **初回アクセス**: DNS 伝播に時間がかかる場合があります（最大48時間）
- **インスタンスタイプ**: デフォルトは t3.medium（最小推奨）
- **データ永続化**: EBS ボリュームに GitLab データを保存
- **料金**: EC2, EBS, Secrets Manager の利用料金が発生します

## 🐛 トラブルシューティング

### GitLab にアクセスできない場合

1. DNS 設定の確認
2. セキュリティグループの確認
3. EC2 インスタンスの状態確認

```bash
# インスタンスの状態確認
aws ec2 describe-instances --instance-ids i-1234567890abcdef0

# GitLab のログ確認
aws ssm start-session --target i-1234567890abcdef0
sudo docker logs gitlab
```

## 🤝 貢献

Issue や Pull Request をお待ちしております！

## 📄 ライセンス

MIT License

## CDK コマンド

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
