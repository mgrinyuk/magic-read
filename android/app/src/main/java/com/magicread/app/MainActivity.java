package com.magicread.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PlayBillingPlugin.class);
        registerPlugin(GoogleAuthPlugin.class);
        super.onCreate(savedInstanceState);

        // Android 15+ (targetSdk 35+) forces edge-to-edge, so the WebView draws
        // behind the status and navigation bars — the header collided with the
        // clock and the bottom tab bar sat under the gesture bar (untappable).
        // Android's WebView reports env(safe-area-inset-*) as 0, so CSS can't
        // compensate; inset the content container by the real system-bar insets
        // here instead. The background matches the app shell so the status-bar
        // strip looks seamless.
        final View content = findViewById(android.R.id.content);
        content.setBackgroundColor(Color.parseColor("#F4F5F9"));
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
    }
}
