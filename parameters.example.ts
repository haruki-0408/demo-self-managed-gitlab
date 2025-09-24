export interface GitLabParameters {
  domainName: string;           // GitLabのドメイン名
  certificateArn: string;      // 既存のSSL証明書ARN（AWS Certificate Manager）
}

// 実際のパラメータを設定してください
export const parameters: GitLabParameters = {
  domainName: 'your-domain.example.com',     // ⚠️ 実際のドメイン名に変更してください
  certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678-1234-1234-1234-123456789012',  // ⚠️ 実際の証明書ARNに変更してください
};