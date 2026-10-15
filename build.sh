#!/bin/zsh
# dist/TokenRelay.dmg (Mac 앱) 와 dist/TokenRelay.apk (폰 앱) 빌드. 외부 다운로드 없음.
# APK 에는 이 Mac 의 Tailscale 주소가 들어가서 폰에서 열면 바로 접속됨.
set -euo pipefail
cd "${0:A:h}"
rm -rf build dist && mkdir -p build dist

# ---------- Android ----------
TS_IP=$(node -e 'const i=Object.values(require("os").networkInterfaces()).flat().find(i=>i.family==="IPv4"&&/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address));console.log(i?i.address:"")')
[ -n "$TS_IP" ] || echo "⚠ Tailscale 주소 없음 — 폰 앱에서 Mac 주소를 직접 입력해야 함 (Tailscale 켜고 다시 빌드 권장)"
SERVER=${TS_IP:+http://$TS_IP:8787/}
SDK=${ANDROID_HOME:-$HOME/Library/Android/sdk}
BT=$SDK/build-tools/$(ls $SDK/build-tools | sort -V | tail -1)
JAR=$SDK/platforms/$(ls $SDK/platforms | sort -V | tail -1)/android.jar
A=build/android
mkdir -p $A/classes $A/gen/com/tokenrelay
printf 'package com.tokenrelay;\nfinal class Config { static final String SERVER = "%s"; }\n' "$SERVER" > $A/gen/com/tokenrelay/Config.java
$BT/aapt2 compile --dir android/res -o $A/res.zip
$BT/aapt2 link $A/res.zip -I $JAR --manifest android/AndroidManifest.xml -o $A/app.apk
javac --release 11 -classpath $JAR -d $A/classes android/src/com/tokenrelay/*.java $A/gen/com/tokenrelay/Config.java
$BT/d8 --release --min-api 29 --lib $JAR --output $A $(find $A/classes -name '*.class')
(cd $A && zip -q app.apk classes.dex)
$BT/zipalign -f 4 $A/app.apk $A/aligned.apk
KS=android/relay.keystore # 업데이트 설치하려면 같은 키로 서명해야 하므로 보관
[ -f $KS ] || keytool -genkeypair -keystore $KS -storepass tokenrelay -keypass tokenrelay -alias relay \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Token Relay" >/dev/null 2>&1
$BT/apksigner sign --ks $KS --ks-pass pass:tokenrelay --out dist/TokenRelay.apk $A/aligned.apk
rm -f dist/TokenRelay.apk.idsig
echo "✓ dist/TokenRelay.apk (접속 주소: ${SERVER:-없음})"

# ---------- Mac ----------
APP=build/dmg/TokenRelay.app
mkdir -p $APP/Contents/MacOS $APP/Contents/Resources
swiftc -O mac/main.swift -o $APP/Contents/MacOS/TokenRelay -framework Cocoa -framework WebKit
cp server.js index.html dist/TokenRelay.apk $APP/Contents/Resources/

# 아이콘: SVG 를 QuickLook 으로 1024px 렌더 → icns
cat > build/icon.svg <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="185" fill="#d97757"/><path d="M330 540h360M560 400l140 140-140 140" stroke="#fff" stroke-width="76" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
SVG
if qlmanage -t -s 1024 -o build build/icon.svg >/dev/null 2>&1; then
  mkdir build/AppIcon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon.svg.png --out build/AppIcon.iconset/icon_${s}x${s}.png >/dev/null
    sips -z $((s*2)) $((s*2)) build/icon.svg.png --out build/AppIcon.iconset/icon_${s}x${s}@2x.png >/dev/null
  done
  iconutil -c icns build/AppIcon.iconset -o $APP/Contents/Resources/AppIcon.icns
fi

cat > $APP/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Token Relay</string>
  <key>CFBundleDisplayName</key><string>Token Relay</string>
  <key>CFBundleIdentifier</key><string>com.tokenrelay.mac</string>
  <key>CFBundleExecutable</key><string>TokenRelay</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
codesign --force --deep -s - $APP
ln -s /Applications build/dmg/Applications
hdiutil create -volname "Token Relay" -srcfolder build/dmg -ov -format UDZO dist/TokenRelay.dmg >/dev/null
echo "✓ dist/TokenRelay.dmg"
