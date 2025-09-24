# Self-Managed GitLab on AWS with CDK

この CDK プロジェクトは、AWS 上に以下の検証用self-managed GitLab 環境を構築します。

## アーキテクチャ構成図

![GitLab AWS Architecture](./docs/architecture.png)

## 機能

- **EC2 インスタンス**: t3.medium , AmazonLinux 2023 環境
- **Application Load Balancer**: SSL/TLS 証明書を使用したHTTPS接続
- **Secrets Manager**: GitLab root パスワードの安全な管理
- **Route53**: 独自ドメインでの DNS 設定
- **VPC**: Private Subnet配置によるセキュリティ強化

## 前提条件

1. **AWS CLI** の設定完了
2. **Node.js** (v18以上) がインストール済み
3. **独自ドメイン** の準備
4. **AWS Certificate Manager** で SSL証明書を事前に取得済み

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. CDK Bootstrap（初回のみ）

```bash
npx cdk bootstrap
```

## デプロイ

### parameters.ts ファイルで設定

1. `parameters.example.ts` を `parameters.ts` にコピー
2. `parameters.ts` を編集
   ```typescript
   export const parameters: GitLabParameters = {
     domainName: 'gitlab.yourdomain.com',     // 実際のドメイン名に変更
     certificateArn: 'arn:aws:acm:region:account:certificate/cert-id',  // 実際の証明書ARNに変更
   };
   ```

3. デプロイ実行
   ```bash
   npx cdk deploy
   ```

## パラメータ説明

| パラメータ | 必須 | 説明 | 例 |
|-----------|------|------|-----|
| `domainName` | 必須 | GitLabの外部ドメインとして設定するドメイン名 | `gitlab.example.com` |
| `certificateArn` | 必須 | AWS Certificate Manager の SSL証明書ARN | `arn:aws:acm:us-east-1:123...` |

## デプロイ完了後

デプロイには約 **10-15分** かかります。完了後：

1. **GitLab URL**: `https://{設定したドメイン名}` でアクセス可能
2. **Root パスワード**: AWS Secrets Manager に自動保存
3. **SSL/TLS証明書**: AWS Certificate Manager により管理

### GitLab にログイン

```bash
# Secrets Manager からパスワードを取得
aws secretsmanager get-secret-value --secret-id gitlab-root-password --query 'SecretString' --output text
```

## 削除

```bash
npx cdk destroy
```

## ライセンス

MIT License

