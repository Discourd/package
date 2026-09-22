const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const unzipper = require('unzipper');
const bplist = require('bplist-parser');
const plist = require('plist');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST_URL || `http://localhost:${PORT}`;

// ディレクトリ設定
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DOWNLOAD_DIR = path.join(PUBLIC_DIR, 'downloads');

fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(PUBLIC_DIR);
fs.ensureDirSync(DOWNLOAD_DIR);

// 静的ファイルの配信
app.use(express.static(PUBLIC_DIR));

// logs.json への直接アクセスを保証
app.get('/logs.json', (req, res) => {
  const logPath = path.join(PUBLIC_DIR, 'logs.json');
  if (fs.existsSync(logPath)) {
    res.setHeader('Content-Type', 'application/json');
    res.sendFile(logPath);
  } else {
    res.status(404).json({ error: 'logs.json not found' });
  }
});

// Multer (IPA一時アップロード)
const upload = multer({ dest: UPLOAD_DIR });

// Socket.IO リアルタイム統計
let activeUsers = 0;
let totalVisits = 0;

io.on('connection', (socket) => {
  activeUsers++;
  totalVisits++;
  io.emit('userCount', activeUsers);
  io.emit('visitCount', totalVisits);

  socket.on('disconnect', () => {
    activeUsers = Math.max(0, activeUsers - 1);
    io.emit('userCount', activeUsers);
  });
});

// DNSプロファイルダウンロード
app.get('/download-dns', (req, res) => {
  const filePath = path.join(__dirname, 'puri.mobileconfig');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/x-apple-asn1-signed-data');
    res.download(filePath, 'puri.mobileconfig');
  } else {
    res.status(404).send('プロファイルが見つかりません');
  }
});

// IPA アップロード＆解析処理
app.post('/upload', upload.single('ipa'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'ファイルが選択されていません' });
  }

  const ipaPath = req.file.path;
  const extractDir = path.join(UPLOAD_DIR, req.file.filename + '_extracted');

  try {
    // IPAの解凍
    await fs.createReadStream(ipaPath)
      .pipe(unzipper.Extract({ path: extractDir }))
      .promise();

    const payloadDir = path.join(extractDir, 'Payload');
    if (!fs.existsSync(payloadDir)) {
      throw new Error('無効なIPAファイルです（Payloadフォルダが存在しません）');
    }

    const files = await fs.readdir(payloadDir);
    const appFolder = files.find(f => f.endsWith('.app'));
    if (!appFolder) {
      throw new Error('.app フォルダが見つかりません');
    }

    const appPath = path.join(payloadDir, appFolder);
    const infoPlistPath = path.join(appPath, 'Info.plist');

    let appName = 'Unknown App';
    let bundleId = 'com.example.app';
    let version = '1.0';

    if (fs.existsSync(infoPlistPath)) {
      try {
        const plistData = await bplist.parseFile(infoPlistPath);
        const info = plistData[0] || {};
        appName = info.CFBundleDisplayName || info.CFBundleName || appName;
        bundleId = info.CFBundleIdentifier || bundleId;
        version = info.CFBundleShortVersionString || info.CFBundleVersion || version;
      } catch (e) {
        const content = await fs.readFile(infoPlistPath, 'utf8');
        const info = plist.parse(content);
        appName = info.CFBundleDisplayName || info.CFBundleName || appName;
        bundleId = info.CFBundleIdentifier || bundleId;
        version = info.CFBundleShortVersionString || info.CFBundleVersion || version;
      }
    }

    // 公開フォルダへ移動
    const appFileId = req.file.filename;
    const targetIpaPath = path.join(DOWNLOAD_DIR, `${appFileId}.ipa`);
    await fs.move(ipaPath, targetIpaPath, { overwrite: true });

    // embedded.mobileprovision の抽出
    const provisionPath = path.join(appPath, 'embedded.mobileprovision');
    let provisionUrl = null;

    if (fs.existsSync(provisionPath)) {
      const targetProvisionPath = path.join(DOWNLOAD_DIR, `${appFileId}.mobileprovision`);
      await fs.copy(provisionPath, targetProvisionPath);
      provisionUrl = `${HOST}/downloads/${appFileId}.mobileprovision`;
    }

    // OTA用 manifest.plist の生成
    const manifestContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${HOST}/downloads/${appFileId}.ipa</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${bundleId}</string>
        <key>bundle-version</key>
        <string>${version}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${appName}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

    const manifestPath = path.join(DOWNLOAD_DIR, `${appFileId}.plist`);
    await fs.writeFile(manifestPath, manifestContent, 'utf8');

    // 解凍作業用ディレクトリの削除
    await fs.remove(extractDir);

    const manifestUrl = `${HOST}/downloads/${appFileId}.plist`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

    res.json({
      success: true,
      appName,
      bundleId,
      version,
      installUrl,
      provisionUrl
    });

  } catch (err) {
    console.error('Processing error:', err);
    await fs.remove(extractDir).catch(() => {});
    await fs.remove(ipaPath).catch(() => {});
    res.status(500).json({ success: false, error: err.message || '解析に失敗しました' });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
