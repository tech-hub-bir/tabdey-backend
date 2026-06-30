const { S3Client } = require('@aws-sdk/client-s3');

const s3 = new S3Client({
  endpoint: 'http://minio-service.default.svc.cluster.local:9000',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ACCESS_KEY,
    secretAccessKey: process.env.MINIO_SECRET_KEY,
  },
  forcePathStyle: true,
});

module.exports = s3;
