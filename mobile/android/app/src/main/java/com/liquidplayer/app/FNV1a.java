package com.liquidplayer.app;

import java.util.Locale;

public final class FNV1a {
    private FNV1a() {}

    public static String hash(String value) {
        int hash = 0x811c9dc5;
        for (int i = 0; i < value.length(); i++) {
            hash = (hash ^ value.charAt(i)) * 0x01000193;
        }
        return String.format(Locale.ROOT, "%08x", hash);
    }
}
