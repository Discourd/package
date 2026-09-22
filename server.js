// 最強版 Apple検証通信ブロック用 DNSプロファイル (.mobileconfig) の配信API
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
            <string>Anti-Revoke 最強DNSプロファイル</string>
            <key>PayloadIdentifier</key>
            <string>com.anti-revoke.dns</string>
            <key>PayloadType</key>
            <string>com.apple.dnsSettings.managed</string>
            <key>PayloadUUID</key>
            <string>a8b2c3d4-e5f6-7890-abcd-ef1234567890</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>Anti-Revoke / Blacklist Bypass DNS</string>
    <key>PayloadIdentifier</key>
    <string>com.anti-revoke.profile</string>
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
  res.setHeader('Content-Disposition', 'attachment; filename="AntiRevoke.mobileconfig"');
  res.send(configXml);
});
