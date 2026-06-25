const { join } = require('path');

const cacheDir = process.env.PUPPETEER_CACHE_DIR || join(__dirname, '.cache', 'puppeteer');

module.exports = {
  cacheDirectory: cacheDir,
  skipDownload: false
};