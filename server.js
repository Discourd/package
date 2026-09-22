const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const plist = require('plist');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// アップロード先フォルダの作成
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage: storage });

// 静的ファイルの配信
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));

// アクセス数の管理
let onlineUsers = 0;
let totalVisits = 0;

io.on('connection', (socket) => {
  onlineUsers++;
  totalVisits++;

  io.emit('userCount', onlineUsers);
  io.emit('visitCount', totalVisits);

  socket.on('disconnect', () => {
    onlineUsers = Math.max(0, onlineUsers - 1);
    io.emit('userCount', onlineUsers);
  });
});

// ぷりプロファイル (Anti-Revoke DNS) 配信API
app.get('/download-dns', (req, res) => {
  const configXml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>DNSSettings</key>
            <dict>
                <key>DNSProtocol</key>
                <string>HTTPS</string>
                <key>ServerURL</key>
                <string>https://dns.nextdns.io</string>
            </dict>
            <key>PayloadDescription</key>
            <string>Appleの証明書検証・ブラックリストチェック通信を強力にブロックします</string>
            <key>PayloadDisplayName</key>
            <string>ぷりプロファイル (Anti-Revoke DNS)</string>
            <key>PayloadIdentifier</key>
            <string>com.puri.dns</string>
            <key>PayloadType</key>
            <string>com.apple.dnsSettings.managed</string>
            <key>PayloadUUID</key>
            <string>a8b2c3d4-e5f6-7890-abcd-ef1234567890</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>ぷりプロファイル</string>
    <key>PayloadIdentifier</key>
    <string>com.puri.profile</string>
    <key>PayloadRemovalDisallowed</key>
    <false/>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>12345678-abcd-ef01-2345-6789abcdef01</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>`;

  res.setHeader('Content-Type', 'application/x-apple-aspen-config');
  res.setHeader('Content-Disposition', 'attachment; filename="PuriProfile.mobileconfig"');
  res.send(configXml);
});

// IPA解析 ＆ アップロードAPI
app.post('/upload', upload.single('ipa'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'ファイルが選択されていません。' });
  }

  const filePath = req.file.path;
  const fileName = req.file.filename;
  const fileBaseName = path.basename(fileName, path.extname(fileName));

  try {
    const zip = new AdmZip(filePath);
    const zipEntries = zip.getEntries();

    let infoPlistEntry = null;
    let provisionEntry = null;

    zipEntries.forEach((entry) => {
      if (entry.entryName.match(/^Payload\/[^\/]+\.app\/Info\.plist$/i)) {
        infoPlistEntry = entry;
      }
      if (entry.entryName.match(/^Payload\/[^\/]+\.app\/embedded\.mobileprovision$/i)) {
        provisionEntry = entry;
      }
    });

    if (!infoPlistEntry) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ success: false, error: '無効なIPAファイルです (Info.plistが見つかりません)。' });
    }

    const plistBuffer = zip.readAsText(infoPlistEntry);
    let appName = 'Unknown App';
    let bundleId = 'unknown.bundle.id';
    let version = '1.0';

    try {
      const parsedPlist = plist.parse(plistBuffer);
      appName = parsedPlist.CFBundleDisplayName || parsedPlist.CFBundleName || appName;
      bundleId = parsedPlist.CFBundleIdentifier || bundleId;
      version = parsedPlist.CFBundleShortVersionString || parsedPlist.CFBundleVersion || version;
    } catch (e) {
      console.log('Plist Parse Warning:', e.message);
    }

    // 署名書プロファイル(.mobileprovision)の抽出保存
    let provisionUrl = null;
    if (provisionEntry) {
      const provisionPath = path.join(uploadDir, `${fileBaseName}.mobileprovision`);
      fs.writeFileSync(provisionPath, provisionEntry.getData());
      provisionUrl = `/uploads/${fileBaseName}.mobileprovision`;
    }

    // 接続ホスト情報の取得
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;

    // OTAインストール用plistの動的生成
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
                    <string>${baseUrl}/uploads/${fileName}</string>
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

    const manifestPath = path.join(uploadDir, `${fileBaseName}.plist`);
    fs.writeFileSync(manifestPath, manifestXml);

    const manifestUrl = `${baseUrl}/uploads/${fileBaseName}.plist`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

    return res.json({
      success: true,
      appName,
      bundleId,
      version,
      installUrl,
      provisionUrl
    });

  } catch (err) {
    console.error('Upload Error:', err);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return res.status(500).json({ success: false, error: 'IPAファイルの解析に失敗しました。' });
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
