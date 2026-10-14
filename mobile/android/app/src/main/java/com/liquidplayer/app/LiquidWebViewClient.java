package com.liquidplayer.app;

import android.content.ContentResolver;
import android.content.UriPermission;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.webkit.MimeTypeMap;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class LiquidWebViewClient extends BridgeWebViewClient {
    private static final String MEDIA_PATH = "/_liquid_media_";
    private final Bridge bridge;

    public LiquidWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        if (!isMediaRoute(url)) return super.shouldInterceptRequest(view, request);

        String value = url.getQueryParameter("u");
        if (value == null) return emptyResponse(404, "Not Found", null);
        return serveMedia(Uri.parse(value), request.getRequestHeaders());
    }

    private boolean isMediaRoute(Uri url) {
        Uri localOrigin = Uri.parse(bridge.getLocalUrl());
        return equal(url.getScheme(), localOrigin.getScheme())
            && equal(url.getAuthority(), localOrigin.getAuthority())
            && MEDIA_PATH.equals(url.getPath());
    }

    private WebResourceResponse serveMedia(Uri mediaUri, Map<String, String> requestHeaders) {
        if (!"content".equals(mediaUri.getScheme()) || !hasPersistedTreeAccess(mediaUri)) {
            return emptyResponse(404, "Not Found", mediaUri);
        }

        AssetFileDescriptor asset = null;
        try {
            ContentResolver resolver = bridge.getContext().getContentResolver();
            asset = resolver.openAssetFileDescriptor(mediaUri, "r");
            if (asset == null) return emptyResponse(404, "Not Found", mediaUri);

            long startOffset = asset.getStartOffset();
            long size = asset.getLength();
            if (size < 0) {
                ParcelFileDescriptor descriptor = asset.getParcelFileDescriptor();
                long statSize = descriptor == null ? -1 : descriptor.getStatSize();
                if (statSize >= startOffset) size = statSize - startOffset;
            }
            if (size < 0) {
                asset.close();
                return emptyResponse(404, "Not Found", mediaUri);
            }

            RangeParser.Range range = RangeParser.parse(header(requestHeaders, "Range"), size);
            if (!range.satisfiable) {
                asset.close();
                Map<String, String> headers = headers(mediaUri, 0);
                headers.put("Accept-Ranges", "bytes");
                headers.put("Content-Range", "bytes */" + size);
                return response(mediaUri, 416, "Range Not Satisfiable", headers, new ByteArrayInputStream(new byte[0]));
            }

            long length = range.length();
            InputStream body;
            if (length == 0) {
                asset.close();
                body = new ByteArrayInputStream(new byte[0]);
            } else {
                FileInputStream file = new FileInputStream(asset.getFileDescriptor());
                file.getChannel().position(startOffset + range.start);
                body = new LimitedInputStream(file, length, asset);
            }

            int status = range.partial ? 206 : 200;
            Map<String, String> headers = headers(mediaUri, length);
            headers.put("Accept-Ranges", "bytes");
            if (range.partial) headers.put("Content-Range", "bytes " + range.start + "-" + range.end + "/" + size);
            return response(mediaUri, status, range.partial ? "Partial Content" : "OK", headers, body);
        } catch (Exception ignored) {
            if (asset != null) {
                try { asset.close(); } catch (IOException ignoredClose) {}
            }
            return emptyResponse(404, "Not Found", mediaUri);
        }
    }

    private boolean hasPersistedTreeAccess(Uri mediaUri) {
        if (!DocumentsContract.isDocumentUri(bridge.getContext(), mediaUri)) return false;
        final String documentId;
        try {
            documentId = DocumentsContract.getDocumentId(mediaUri);
        } catch (IllegalArgumentException ignored) {
            return false;
        }

        for (UriPermission permission : bridge.getContext().getContentResolver().getPersistedUriPermissions()) {
            Uri treeUri = permission.getUri();
            if (!permission.isReadPermission()
                || !DocumentsContract.isTreeUri(treeUri)
                || !equal(treeUri.getAuthority(), mediaUri.getAuthority())) {
                continue;
            }
            try {
                String treeId = DocumentsContract.getTreeDocumentId(treeUri);
                String prefix = treeId.endsWith("/") || treeId.endsWith(":") ? treeId : treeId + "/";
                if (documentId.equals(treeId) || documentId.startsWith(prefix)) return true;
            } catch (IllegalArgumentException ignored) {}
        }
        return false;
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (name.equalsIgnoreCase(entry.getKey())) return entry.getValue();
        }
        return null;
    }

    private static Map<String, String> headers(Uri uri, long contentLength) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Type", mimeType(uri));
        headers.put("Content-Length", Long.toString(contentLength));
        headers.put("Access-Control-Allow-Origin", "*");
        return headers;
    }

    private static WebResourceResponse emptyResponse(int status, String reason, Uri uri) {
        Map<String, String> headers = uri == null ? new HashMap<>() : headers(uri, 0);
        headers.put("Access-Control-Allow-Origin", "*");
        return response(uri, status, reason, headers, new ByteArrayInputStream(new byte[0]));
    }

    private static WebResourceResponse response(
        Uri uri, int status, String reason, Map<String, String> headers, InputStream body
    ) {
        return new WebResourceResponse(mimeType(uri), null, status, reason, headers, body);
    }

    private static String mimeType(Uri uri) {
        if (uri != null) {
            String filename = uri.getLastPathSegment();
            if (filename != null) {
                int dot = filename.lastIndexOf('.');
                if (dot >= 0 && dot < filename.length() - 1) {
                    String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(
                        filename.substring(dot + 1).toLowerCase(Locale.ROOT)
                    );
                    if (mime != null) return mime;
                }
            }
        }
        return "application/octet-stream";
    }

    private static boolean equal(String first, String second) {
        return first == null ? second == null : first.equals(second);
    }

    private static final class LimitedInputStream extends FilterInputStream {
        private long remaining;
        private final AssetFileDescriptor asset;

        LimitedInputStream(InputStream stream, long length, AssetFileDescriptor asset) {
            super(stream);
            remaining = length;
            this.asset = asset;
        }

        @Override
        public int read() throws IOException {
            if (remaining == 0) return -1;
            int value = super.read();
            if (value >= 0) remaining--;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (length == 0) return 0;
            if (remaining == 0) return -1;
            int count = super.read(buffer, offset, (int) Math.min(length, remaining));
            if (count > 0) remaining -= count;
            return count;
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                asset.close();
            }
        }
    }
}
