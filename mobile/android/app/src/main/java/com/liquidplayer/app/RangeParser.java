package com.liquidplayer.app;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class RangeParser {
    private static final long MAX_SAFE_INTEGER = 9007199254740991L;
    private static final Pattern BYTE_RANGE = Pattern.compile("^bytes=(\\d*)-(\\d*)$");

    static final class Range {
        final boolean satisfiable;
        final boolean partial;
        final long start;
        final long end;

        private Range(boolean satisfiable, boolean partial, long start, long end) {
            this.satisfiable = satisfiable;
            this.partial = partial;
            this.start = start;
            this.end = end;
        }

        long length() {
            return satisfiable && end >= start ? end - start + 1 : 0;
        }
    }

    private RangeParser() {}

    static Range parse(String header, long size) {
        if (size < 0) return unsatisfiable();
        if (header == null) return new Range(true, false, 0, size - 1);
        if (size == 0) return unsatisfiable();

        Matcher match = BYTE_RANGE.matcher(header);
        if (!match.matches() || (match.group(1).isEmpty() && match.group(2).isEmpty())) {
            return unsatisfiable();
        }

        try {
            long start;
            long end;
            if (match.group(1).isEmpty()) {
                long suffix = parseSafeLong(match.group(2));
                if (suffix == 0) return unsatisfiable();
                start = Math.max(0, size - suffix);
                end = size - 1;
            } else {
                start = parseSafeLong(match.group(1));
                end = match.group(2).isEmpty() ? size - 1 : parseSafeLong(match.group(2));
                end = Math.min(end, size - 1);
            }
            if (!isSafeInteger(start) || !isSafeInteger(end) || start >= size || start > end) {
                return unsatisfiable();
            }
            return new Range(true, true, start, end);
        } catch (NumberFormatException ignored) {
            return unsatisfiable();
        }
    }

    private static long parseSafeLong(String value) {
        long parsed = Long.parseLong(value);
        if (!isSafeInteger(parsed)) throw new NumberFormatException();
        return parsed;
    }

    private static boolean isSafeInteger(long value) {
        return value >= 0 && value <= MAX_SAFE_INTEGER;
    }

    private static Range unsatisfiable() {
        return new Range(false, true, 0, -1);
    }
}
