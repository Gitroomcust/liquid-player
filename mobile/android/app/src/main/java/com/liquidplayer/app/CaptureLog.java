package com.liquidplayer.app;

import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public final class CaptureLog {
    private static final int MAX_LINES = 300;
    private static final String TAG = "LiquidPlayer";
    private static final ArrayDeque<String> lines = new ArrayDeque<>(MAX_LINES);
    private static final SimpleDateFormat timestampFormat = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US);

    private CaptureLog() {}

    public static void log(String message) {
        String line;
        synchronized (lines) {
            line = timestampFormat.format(new Date()) + " " + message;
            if (lines.size() == MAX_LINES) lines.removeFirst();
            lines.addLast(line);
        }
        Log.i(TAG, line);
    }

    public static void exception(String step, Throwable error) {
        log(step + ": " + error.getClass().getName() + ": " + String.valueOf(error.getMessage()));
    }

    public static List<String> snapshot() {
        synchronized (lines) {
            return new ArrayList<>(lines);
        }
    }
}
