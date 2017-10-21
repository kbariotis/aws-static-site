const AWS = require('aws-sdk');
const glob = require('glob');
const fs = require('fs');
const path = require('path');
const BPromise = require('bluebird');
const mime = require('mime-types')

const cloudFront = new AWS.CloudFront({
  region: 'eu-central-1'
});

const s3 = new AWS.S3({
  apiVersion: '2006-03-01',
  signatureVersion: 'v4',
  region: 'eu-central-1'
});

/**
 *
 * @param {Object} options
 * @param {String} options.siteName
 * @param {String} options.uploadFolder
 * @returns {Object}
 */
function init(options) {
  return {
    deploy: () => deploy(options.siteName, options.uploadFolder),
  }
}

/**
 * Fetch CloudFront distribution id based on the Alias CNAME
 * @param {String} S3BucketToUpload
 * @returns {Promise<(string|null)>}
 */
function getDistributionId(S3BucketToUpload) {
  return cloudFront.listDistributions().promise()
    .then(list => list.DistributionList.Items)
    .then(items => items.filter(item => item.Aliases.Items.indexOf(S3BucketToUpload) > -1))
    .then(filteredItems => (filteredItems.length ? filteredItems[0].Id : null))
    .then((id) => {
      if (!id) {
        return createDistribution(S3BucketToUpload);
      }

      return id;
    })
}

/**
 *
 * @param {String} S3BucketToUpload
 * @returns {Promise}
 */
function createDistribution(S3BucketToUpload) {
  return cloudFront.createDistribution({
    DistributionConfig: {
      CallerReference: Date.now().toString(),
      Comment: 'Created by aws-static-state',
      DefaultCacheBehavior: {
        ForwardedValues: {
          Cookies: {
            Forward: 'all',
          },
          QueryString: true
        },
        MinTTL: 0,
        TargetOriginId: `${S3BucketToUpload}-${Date.now().toString()}`,
        TrustedSigners: {
          Enabled: true,
          Quantity: 0,
        },
        ViewerProtocolPolicy: 'redirect-to-https',
        Compress: true
      },
      Enabled: true,
      Origins: {
        Quantity: 1,
        Items: [
          {
            DomainName: `${S3BucketToUpload}.s3.amazonaws.com`,
            Id: `${S3BucketToUpload}-${Date.now().toString()}`,
            S3OriginConfig: {
              OriginAccessIdentity: '',
            },
            OriginPath: ''
          }
        ]
      },
      Aliases: {
        Quantity: 1,
        Items: [
          S3BucketToUpload,
        ]
      },
      DefaultRootObject: 'index.html',
      HttpVersion: 'http2',
      IsIPV6Enabled: true,
      ViewerCertificate: {
        CertificateSource: 'cloudfront',
        CloudFrontDefaultCertificate: true
      }
    }
  })
    .promise()
    .then(response => response.Distribution.Id)
}

/**
 * Invalidate Cloudfront Distribution and specific file names
 *
 * We are invalidating only the main entry point (app.js). Chunks are
 * being cached based on their filenames(hashes).
 *
 * @param {String} bucketName
 * @param {Array<String>} filesToInvalidate
 * @returns {Promise}
 */
function invalidateCache(bucketName, filesToInvalidate) {
  return getDistributionId(bucketName)
    .then(id => {
      if (!id) {
        console.log('No Cloudfront distribution found. Skipping cache invalidation.');
        return true;
      }

      return createInvalidation(id, filesToInvalidate);
    });
}

/**
 *
 * @param {String} id
 * @param {Array} filesToInvalidate
 * @returns {Promise}
 */
function createInvalidation(id, filesToInvalidate) {
  return cloudFront.createInvalidation({
    DistributionId: id,
    InvalidationBatch: {
      CallerReference: Date.now().toString(),
      Paths: {
        Quantity: filesToInvalidate.length,
        Items: filesToInvalidate,
      }
    }
  })
    .promise()
    .then(() => true);
}

/**
 * @param {string} folderToUpload The local folder whos files will be uploaded
 * @param {string} bucketName The remote bucket name
 * @returns {BPromise}
 */
function uploadFiles(folderToUpload, bucketName) {
  const files = glob.sync(`${folderToUpload}/**/*.*`);

  return BPromise.map(files, (file) => uploadFile(bucketName, file.replace(folderToUpload, '')))
    .then(files => files.filter(file => !!file).map(file => `/${file}`))
}

/**
 * @param {String} bucketName
 * @param {String} file
 * @returns {Promise}
 */
function uploadFile(bucketName, file) {
  const params = {
    Bucket: bucketName,
    ACL: 'public-read'
  };

  let fileObject = Object.assign({}, params, {
    Body: fs.readFileSync(file),
    Key: file
  });

  const ext = path.parse(file).ext;
  fileObject = Object.assign({}, fileObject, {
    ContentType: mime.lookup(ext)
  });

  return s3.putObject(fileObject)
    .promise()
    .then(() => {
      console.log(`${file} file uploaded`);
      return file;
    })
    .catch((err) => {
      console.log(`Error while uploading ${file}`);
      throw new Error(err);
    });
}

/**
 * Create an S3 bucket web based
 * @param {string} bucketName
 * @returns {Promise}
 */
function createBucket(bucketName) {
  return s3.createBucket({
    Bucket: bucketName,
  })
    .promise()
    .catch((err) => {
      if (err.code !== 'BucketAlreadyOwnedByYou') {
        throw new Error(err);
      }

      return true;
    })
    .then(() => s3.putBucketWebsite({
      Bucket: bucketName,
      WebsiteConfiguration: {
        IndexDocument: {
          Suffix: 'index.html'
        },
        ErrorDocument: {
          Key: 'error.html'
        }
      }
    }).promise())
    .then(() => true);
}

/**
 *
 * @param {String} S3BucketToUpload - The name of the bucket
 * @param {String} uploadFolder - The folder to upload
 *
 * @returns {Promise}
 */
function deploy(S3BucketToUpload, uploadFolder) {
  return createBucket(S3BucketToUpload)
    .then(() => uploadFiles(uploadFolder, S3BucketToUpload))
    .then((files) => invalidateCache(S3BucketToUpload, files))
    .then(() => console.log('Upload done.'))
    .catch((err) => {
      console.log(err);
      process.exit(1);
    });
}

module.exports = init;
