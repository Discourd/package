const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');

fs.ensureDirSync(UPLOAD_DIR);

// .mobileconfig 配信時に正しいMIME Typeを設定
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mobileconfig')) {
      res.setHeader('Content-Type', 'application/x-apple-aspen-config');
    }
  }
}));

// オンライン人数カウント
let onlineUsers = 0;
io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('userCount', onlineUsers);

  socket.on('disconnect', () => {
    onlineUsers--;
    io.emit('userCount', onlineUsers);
  });
});

// Multer設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSub = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSub + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// IPA処理API
app.post('/upload', upload.single('ipa'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルが選択されていません' });
  }

  const ipaPath = req.file.path;
  const fileName = req.file.filename;
  const extractDir = path.join(UPLOAD_DIR, 'extracted-' + Date.now());

  try {
    const zip = new AdmZip(ipaPath);
    zip.extractAllTo(extractDir, true);

    const payloadPath = path.join(extractDir, 'Payload');
    if (!fs.existsSync(payloadPath)) {
      throw new Error('無効なIPAファイルです(Payloadフォルダなし)');
    }

    const appDirs = fs.readdirSync(payloadPath).filter(f => f.endsWith('.app'));
    if (appDirs.length === 0) {
      throw new Error('.app フォルダが見つかりません');
    }

    const appPath = path.join(payloadPath, appDirs[0]);
    const infoPlistPath = path.join(appPath, 'Info.plist');
    const provisionPath = path.join(appPath, 'embedded.mobileprovision');

    let bundleId = 'com.example.app';
    let version = '1.0';
    let appName = appDirs[0].replace('.app', '');

    if (fs.existsSync(infoPlistPath)) {
      const plistContent = fs.readFileSync(infoPlistPath, 'utf8');
      const bMatch = plistContent.match(/<key>CFBundleIdentifier<\/key>[\s\S]*?<string>(.*?)<\/string>/);
      if (bMatch) bundleId = bMatch[1];

      const vMatch = plistContent.match(/<key>CFBundleShortVersionString<\/key>[\s\S]*?<string>(.*?)<\/string>/);
      if (vMatch) version = vMatch[1];

      const nMatch = plistContent.match(/<key>CFBundleDisplayName<\/key>[\s\S]*?<string>(.*?)<\/string>/);
      if (nMatch) appName = nMatch[1];
    }

    let provisionUrl = null;
    if (fs.existsSync(provisionPath)) {
      const provFileName = `provision-${Date.now()}.mobileprovision`;
      const provDestPath = path.join(UPLOAD_DIR, provFileName);
      await fs.copy(provisionPath, provDestPath);
      provisionUrl = `/uploads/${provFileName}`;
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const ipaDownloadUrl = `${baseUrl}/uploads/${fileName}`;

    const manifestXml = `<?xml version="1.0" encoding="UTF-8"?>
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
                    <string>${ipaDownloadUrl}</string>
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

    const manifestFileName = `manifest-${Date.now()}.plist`;
    const manifestPath = path.join(UPLOAD_DIR, manifestFileName);
    fs.writeFileSync(manifestPath, manifestXml);

    const manifestUrl = `${baseUrl}/uploads/${manifestFileName}`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

    await fs.remove(extractDir);

    res.json({
      success: true,
      appName,
      bundleId,
      version,
      installUrl,
      provisionUrl
    });

  } catch (err) {
    console.error(err);
    if (fs.existsSync(extractDir)) await fs.remove(extractDir);
    res.status(500).json({ error: 'IPA解析エラー: ' + err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
