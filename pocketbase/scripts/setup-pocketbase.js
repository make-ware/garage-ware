#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const POCKETBASE_VERSION = '0.39.10';
const MAX_REDIRECTS = 5;

const PLATFORM_MAP = {
  darwin: 'darwin',
  linux: 'linux',
  win32: 'windows',
};

const ARCH_MAP = {
  x64: 'amd64',
  arm64: 'arm64',
};

function getPlatformInfo() {
  const platform = PLATFORM_MAP[process.platform];
  const arch = ARCH_MAP[process.arch];

  if (!platform || !arch) {
    throw new Error(`Unsupported platform: ${process.platform} ${process.arch}`);
  }

  return { platform, arch };
}

// Resolve the final URL first, then open the write stream exactly once.
// GitHub release downloads always redirect to objects.githubusercontent.com.
function get(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (response) => {
        const { statusCode, headers } = response;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume(); // drain so the socket can be reused
          if (redirectsLeft === 0) {
            reject(new Error(`Too many redirects fetching ${url}`));
            return;
          }
          resolve(get(new URL(headers.location, url).toString(), redirectsLeft - 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`Failed to download ${url}: HTTP ${statusCode}`));
          return;
        }

        resolve(response);
      })
      .on('error', reject);
  });
}

async function downloadFile(url, dest) {
  console.log(`Downloading ${url}...`);
  const response = await get(url);

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fail = (err) => {
      file.destroy();
      response.destroy();
      fs.rm(dest, { force: true }, () => reject(err));
    };

    response.on('error', fail);
    file.on('error', fail);
    file.on('finish', resolve);
    response.pipe(file);
  });
}

function installedVersion(executablePath) {
  try {
    const out = execSync(`"${executablePath}" --version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = out.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function setupPocketBase() {
  const { platform, arch } = getPlatformInfo();

  // This script lives in pocketbase/scripts/, so the workspace root is one level up.
  const pbDir = path.resolve(__dirname, '..');
  fs.mkdirSync(pbDir, { recursive: true });

  const isWindows = platform === 'windows';
  const executableName = isWindows ? 'pocketbase.exe' : 'pocketbase';
  const filename = `pocketbase_${POCKETBASE_VERSION}_${platform}_${arch}.zip`;
  const downloadUrl = `https://github.com/pocketbase/pocketbase/releases/download/v${POCKETBASE_VERSION}/${filename}`;
  const zipPath = path.join(pbDir, filename);
  const executablePath = path.join(pbDir, executableName);

  if (fs.existsSync(executablePath)) {
    const current = installedVersion(executablePath);
    if (current === POCKETBASE_VERSION) {
      console.log(`✅ PocketBase v${POCKETBASE_VERSION} is already installed`);
      return executablePath;
    }
    console.log(
      current
        ? `⬆️  Found PocketBase v${current}, upgrading to v${POCKETBASE_VERSION}...`
        : '⚠️  Existing PocketBase binary seems corrupted, re-downloading...'
    );
  }

  console.log(`📦 Setting up PocketBase v${POCKETBASE_VERSION} for ${platform}/${arch}...`);

  await downloadFile(downloadUrl, zipPath);
  console.log('✅ Download completed');

  try {
    console.log('📂 Extracting PocketBase...');

    // Unlink rather than letting unzip truncate in place: replacing a running
    // binary that way fails with ETXTBSY, whereas unlink always succeeds.
    fs.rmSync(executablePath, { force: true });

    if (process.platform === 'win32') {
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${pbDir}' -Force"`, {
        stdio: 'inherit',
      });
    } else {
      execSync(`unzip -o "${zipPath}"`, { cwd: pbDir, stdio: 'inherit' });
    }

    if (!isWindows) {
      fs.chmodSync(executablePath, 0o755);
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  console.log('✅ PocketBase setup completed!');
  console.log(`📍 PocketBase binary location: ${executablePath}`);
  console.log('');
  console.log('🚀 Quick start:');
  console.log('  yarn dev                              - Start webapp + shared (watch) + PocketBase');
  console.log('  yarn workspace @garage-ware/pb dev    - Start PocketBase only (:8090)');
  console.log('  yarn workspace @garage-ware/pb admin  - Create the PocketBase superuser');

  return executablePath;
}

if (require.main === module) {
  setupPocketBase().catch((error) => {
    console.error('❌ Error setting up PocketBase:', error.message);
    process.exit(1);
  });
}

module.exports = { setupPocketBase };
