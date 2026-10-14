package com.liquidplayer.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FNV1aTest {
    @Test
    public void matchesJavascriptUtf16Vectors() {
        assertEquals("811c9dc5", FNV1a.hash(""));
        assertEquals("4f9f2cab", FNV1a.hash("hello"));
        assertEquals("1c07a122", FNV1a.hash("\uD83C\uDFB5/\u00E9"));
    }
}
