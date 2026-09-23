const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const AdmZip = require('adm-zip');
const plist = require('simple-plist');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// アップロード用ディレクトリの存在確認・作成
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// 静的ファイルの提供
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer（ファイルアップロード設定）
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + '.ipa');
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 最大2GBまで許可
});

// Socket.IO リアルタイム通信
let onlineCount = 0;
let totalVisits = 0;

io.on('connection', (socket) => {
  onlineCount++;
  totalVisits++;
  
  io.emit('userCount', onlineCount);
  io.emit('visitCount', totalVisits);

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('userCount', onlineCount);
  });
});

/**
 * 1. ぷりプロファイル (Anti-Revoke DNSプロファイル) 配信API
 * iOSが構成プロファイルとして正常に認識できる MIME タイプで配信します
 */
app.get('/download-dns', (req, res) => {
  const profileXML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array/>
  <key>PayloadDisplayName</key>
  <string>ぷりプロファイル (Anti-Revoke)</string>
  <key>PayloadIdentifier</key>
  <string>com.puri.antirevoke.profile</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>98765432-1234-5678-1234-567812345678</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-asf');
  res.setHeader('Content-Disposition', 'attachment; filename="puri_profile.mobileconfig"');
  res.send(profileXML);
});

/**
 * 2. IPAアップロード ＆ 解析・抽出処理API
 */
app.post('/upload', upload.single('ipa'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'ファイルが選択されていません。' });
  }

  const ipaPath = req.file.path;
  const fileId = path.basename(ipaPath, '.ipa');
  const extractDir = path.join(UPLOAD_DIR, fileId);

  try {
    // IPA解凍処理
    const zip = new AdmZip(ipaPath);
    zip.extractAllTo(extractDir, true);

    const payloadDir = path.join(extractDir, 'Payload');
    if (!fs.existsSync(payloadDir)) {
      throw new Error('無効なIPAファイルです（Payloadフォルダが見つかりません）。');
    }

    const appFolders = fs.readdirSync(payloadDir).filter(f => f.endsWith('.app'));
    if (appFolders.length === 0) {
      throw new Error('.app フォルダが見つかりませんでした。');
    }

    const appPath = path.join(payloadDir, appFolders[0]);
    const infoPlistPath = path.join(appPath, 'Info.plist');

    // Info.plist 解析
    if (!fs.existsSync(infoPlistPath)) {
      throw new Error('Info.plist が見つかりませんでした。');
    }
    const infoPlistData = plist.readFileSync(infoPlistPath);

    const appName = infoPlistData.CFBundleDisplayName || infoPlistData.CFBundleName || 'Unknown App';
    const bundleId = infoPlistData.CFBundleIdentifier || 'com.unknown.app';
    const version = infoPlistData.CFBundleShortVersionString || infoPlistData.CFBundleVersion || '1.0';

    // 【署名書 (.mobileprovision) 抽出の強化処理】
    // 大文字小文字の違い（例: embedded.mobileprovision, Embedded.mobileprovision）を問わず検索
    let provisionUrl = null;
    const appFiles = fs.readdirSync(appPath);
    const provisionFileName = appFiles.find(f => f.toLowerCase() === 'embedded.mobileprovision');

    if (provisionFileName) {
      const sourceProvisionPath = path.join(appPath, provisionFileName);
      const targetProvisionPath = path.join(UPLOAD_DIR, `${fileId}.mobileprovision`);
      fs.copyFileSync(sourceProvisionPath, targetProvisionPath);
      
      // ダウンロード用URLの生成
      provisionUrl = `/uploads/${fileId}.mobileprovision`;
      console.log(`[成功] 署名書を抽出しました: ${fileId}.mobileprovision`);
    } else {
      console.log(`[情報] ${appName} には embedded.mobileprovision が含まれていません（App Store版や暗号化IPAの可能性があります）。`);
    }

    // OTAインストール用 manifest.plist の生成
    const host = req.get('host');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol; // リバースプロキシ(HTTPS)対応
    const ipaDownloadUrl = `${protocol}://${host}/uploads/${fileId}.ipa`;
    
    const manifestPlist = `<?xml version="1.0" encoding="UTF-8"?>
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

    const manifestPath = path.join(UPLOAD_DIR, `${fileId}.plist`);
    fs.writeFileSync(manifestPath, manifestPlist);

    const manifestUrl = `${protocol}://${host}/uploads/${fileId}.plist`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

    // サーバーの容量節約のため解凍一時フォルダを削除
    fs.rmSync(extractDir, { recursive: true, force: true });

    return res.json({
      success: true,
      appName,
      bundleId,
      version,
      installUrl,
      provisionUrl
    });

  } catch (err) {
    console.error('[エラー]', err.message);
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// サーバー起動
server.listen(PORT, () => {
  console.log(`=================================`);
  console.log(` ぷりIPAサーバーが正常起動しました`);
  console.log(` URL: http://localhost:${PORT}`);
  console.log(`=================================`);
});
