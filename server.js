const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const bplist = require('bplist-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multerの設定（一時保存先）
const upload = multer({ dest: '/tmp/' });

app.post('/upload', upload.single('ipa'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).send('IPAファイルが指定されていません。');
    }

    const host = req.get('host');
    const protocol = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    const tempFilePath = req.file.path;
    const fileId = Date.now().toString();
    const targetFolder = path.join(uploadDir, fileId);
    fs.mkdirSync(targetFolder, { recursive: true });

    const savedIpaPath = path.join(targetFolder, 'app.ipa');
    
    // 一時ファイルを移動
    fs.renameSync(tempFilePath, savedIpaPath);

    // ZIPとしてIPAをオープン
    let zip;
    try {
      zip = new AdmZip(savedIpaPath);
    } catch (zipErr) {
      console.error('ZIP解凍エラー:', zipErr);
      return res.status(400).send('不正なIPA（ZIP）ファイルです。');
    }

    // Info.plist を検索
    const zipEntries = zip.getEntries();
    const infoPlistEntry = zipEntries.find(entry => 
      /^Payload\/[^\/]+\.app\/Info\.plist$/i.test(entry.entryName)
    );

    if (!infoPlistEntry) {
      console.error('Info.plistが見つかりません。エントリー一覧:', zipEntries.map(e => e.entryName));
      return res.status(400).send('IPA内に Info.plist が見つかりませんでした。');
    }

    // Info.plistの読み込みとパース (バイナリ or XML 対応)
    const plistBuffer = infoPlistEntry.getData();
    let plistData;

    try {
      // バイナリplistの解析を試行
      const parsed = bplist.parseBuffer(plistBuffer);
      plistData = parsed[0];
    } catch (e) {
      // バイナリ解析失敗時は文字列（XML plist）として簡易フォールバック処理
      console.log('bplistパース失敗。XML形式としてフォールバック解析を試みます。');
      const plistString = plistBuffer.toString('utf8');
      
      const getXmlValue = (key) => {
        const regex = new RegExp(`<key>${key}</key>\\s*<string>(.*?)</string>`, 'i');
        const match = plistString.match(regex);
        return match ? match[1] : null;
      };

      plistData = {
        CFBundleIdentifier: getXmlValue('CFBundleIdentifier'),
        CFBundleShortVersionString: getXmlValue('CFBundleShortVersionString'),
        CFBundleVersion: getXmlValue('CFBundleVersion'),
        CFBundleDisplayName: getXmlValue('CFBundleDisplayName'),
        CFBundleName: getXmlValue('CFBundleName')
      };
    }

    if (!plistData || !plistData.CFBundleIdentifier) {
      return res.status(400).send('Info.plistから Bundle ID を取得できませんでした。');
    }

    const bundleId = plistData.CFBundleIdentifier;
    const bundleVersion = plistData.CFBundleShortVersionString || plistData.CFBundleVersion || '1.0.0';
    const appName = plistData.CFBundleDisplayName || plistData.CFBundleName || 'App';

    // manifest.plist の生成
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
    console.error('サーバー処理全体エラー:', error);
    res.status(500).send(`サーバー処理エラー: ${error.message || error}`);
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
