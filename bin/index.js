#!/usr/local/bin/node

const AWSStaticSite = require('./../src')({
  siteName: 'kostas.com',
  uploadFolder: 'public',
});

AWSStaticSite.deploy();
