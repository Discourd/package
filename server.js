const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const bplist = require('bplist-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// public ディレクトリ（静的ファイル提供）
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({ dest: '/tmp/' });

app.post('/upload', upload.single('ipa'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send('IPAファイルがありません');

    // Renderが提供するHTTPS URLを動的に取得
    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const tempFilePath = req.file.path;
    const fileId = Date.now().toString();
    const targetFolder = path.join(uploadDir, fileId);
    fs.mkdirSync(targetFolder);

    const savedIpaPath = path.join(targetFolder, 'app.ipa');
    fs.renameSync(tempFilePath, savedIpaPath);

    // ZIP解凍してInfo.plist取得
    const zip = new AdmZip(savedIpaPath);
    const infoPlistEntry = zip.getEntries().find(entry => 
      /^Payload\/[^\/]+\.app\/Info\.plist$/i.test(entry.entryName)
    );

    if (!infoPlistEntry) return res.status(400).send('Info.plistが見つかりません');

    const [plistData] = bplist.parseBuffer(infoPlistEntry.getData());
    const bundleId = plistData.CFBundleIdentifier;
    const bundleVersion = plistData.CFBundleShortVersionString || plistData.CFBundleVersion || '1.0.0';
    const appName = plistData.CFBundleDisplayName || plistData.CFBundleName || 'App';

    // manifest.plist 作成
    const ipaUrl = `${baseUrl}/uploads/${fileId}/app.ipa`;
    const manifestContent = generateManifestXml(ipaUrl, bundleId, bundleVersion, appName);
    
    fs.writeFileSync(path.join(targetFolder, 'manifest.plist'), manifestContent, 'utf8');

    const manifestUrl = `${baseUrl}/uploads/${fileId}/manifest.plist`;
    const installUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;

    res.json({
      success: true,
      appName,
      bundleId,
      version: bundleVersion,
      installUrl
    });

  } catch (error) {
    console.error(error);
    res.status(500).send('エラーが発生しました');
  }
});

function generateManifestXml(ipaUrl, bundleId, version, appName) {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
                    <string>${ipaUrl}</string>
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
}

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
