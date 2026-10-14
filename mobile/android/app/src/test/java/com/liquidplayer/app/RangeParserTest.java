package com.liquidplayer.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class RangeParserTest {
    @Test
    public void supportsFullOpenEndedSuffixAndClampedRanges() {
        RangeParser.Range full = RangeParser.parse(null, 100);
        assertTrue(full.satisfiable);
        assertFalse(full.partial);
        assertEquals(100, full.length());

        RangeParser.Range explicit = RangeParser.parse("bytes=10-19", 100);
        assertTrue(explicit.satisfiable);
        assertTrue(explicit.partial);
        assertEquals(10, explicit.start);
        assertEquals(19, explicit.end);

        RangeParser.Range openEnded = RangeParser.parse("bytes=10-", 100);
        assertEquals(99, openEnded.end);

        RangeParser.Range suffix = RangeParser.parse("bytes=-10", 100);
        assertEquals(90, suffix.start);
        assertEquals(99, suffix.end);

        RangeParser.Range clamped = RangeParser.parse("bytes=90-999", 100);
        assertEquals(99, clamped.end);

        RangeParser.Range longSuffix = RangeParser.parse("bytes=-200", 100);
        assertEquals(0, longSuffix.start);
    }

    @Test
    public void rejectsMalformedAndUnsatisfiableRanges() {
        assertFalse(RangeParser.parse("bytes=", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=1-2,3-4", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=-0", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=100-", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=30-20", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=0-", 0).satisfiable);
        assertFalse(RangeParser.parse("bytes=9007199254740992-", 100).satisfiable);
        assertFalse(RangeParser.parse("bytes=0-9223372036854775808", 100).satisfiable);
    }
}
