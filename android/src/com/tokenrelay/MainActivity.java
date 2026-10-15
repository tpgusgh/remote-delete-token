package com.tokenrelay;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;

// Mac 의 Token Relay 화면을 보여주는 WebView 앱.
// 서버 주소(Mac 의 Tailscale IP)는 빌드 때 Config.SERVER 로 들어가서 열면 바로 접속됨.
public class MainActivity extends Activity {
    private WebView web;
    private SharedPreferences prefs;
    private AlertDialog errorDialog;

    private String server() {
        return prefs.getString("url", Config.SERVER);
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("relay", MODE_PRIVATE);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebChromeClient(new WebChromeClient()); // JS alert 표시
        web.setWebViewClient(new WebViewClient() {
            // 서버 밖 링크(claude 로그인 등)는 외부 브라우저로
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String host = r.getUrl().getHost();
                if (host != null && host.equals(Uri.parse(server()).getHost())) return false;
                startActivity(new Intent(Intent.ACTION_VIEW, r.getUrl()));
                return true;
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showOffline();
            }
        });
        setContentView(web);
        web.loadUrl(server());
    }

    // Mac 앱이 꺼져 있거나 Tailscale 이 끊긴 경우
    private void showOffline() {
        if (errorDialog != null && errorDialog.isShowing()) return;
        errorDialog = new AlertDialog.Builder(this)
            .setTitle("Mac 에 연결할 수 없어요")
            .setMessage("• Mac 에서 Token Relay 앱이 켜져 있는지\n• 폰과 Mac 의 Tailscale 이 켜져 있는지\n확인 후 다시 시도하세요.\n\n" + server())
            .setCancelable(false)
            .setPositiveButton("다시 시도", (d, w) -> web.loadUrl(server()))
            .setNeutralButton("주소 변경", (d, w) -> askUrl())
            .show();
    }

    private void askUrl() {
        EditText in = new EditText(this);
        in.setSingleLine();
        in.setText(server());
        new AlertDialog.Builder(this)
            .setTitle("Mac 주소")
            .setMessage("Mac 앱 메뉴에 표시된 주소 (예: http://100.x.x.x:8787/)")
            .setView(in)
            .setPositiveButton("연결", (d, w) -> {
                String url = in.getText().toString().trim();
                if (!url.startsWith("http")) url = "http://" + url;
                prefs.edit().putString("url", url).apply();
                web.loadUrl(url);
            })
            .setNegativeButton("기본값", (d, w) -> {
                prefs.edit().remove("url").apply();
                web.loadUrl(server());
            })
            .show();
    }

    @Override
    public boolean onCreateOptionsMenu(Menu m) {
        m.add(0, 1, 0, "새로고침");
        m.add(0, 2, 0, "Mac 주소 변경");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == 1) web.loadUrl(server());
        if (item.getItemId() == 2) askUrl();
        return true;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
