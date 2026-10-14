package com.liquidplayer.app;

import android.Manifest;
import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.MediaMetadataRetriever;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.provider.Settings.Secure;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.util.Base64;

import androidx.documentfile.provider.DocumentFile;

import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.PermissionCallback;
import com.getcapacitor.annotation.Permission;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(
    name = "LiquidPlayer",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class LiquidPlayerPlugin extends Plugin {
    private static final int MAX_FILES = 5000;
    private static final int MAX_DEPTH = 6;
    private static final Set<String> AUDIO_EXT = new HashSet<>(Arrays.asList(
        ".mp3", ".flac", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".webm"
    ));
    private static volatile LiquidPlayerPlugin instance;
    private final AtomicInteger generation = new AtomicInteger();
    private final ExecutorService metadataWorkers = Executors.newFixedThreadPool(8);
    private final ScheduledExecutorService sessionWorker = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, MediaController> controllers = new HashMap<>();
    private final Map<String, MediaController.Callback> controllerCallbacks = new HashMap<>();
    private final Map<String, String> sessionSnapshots = new HashMap<>();
    private final Map<String, Long> sessionPositions = new HashMap<>();
    private volatile boolean sessionAccess;

    @Override
    public void load() {
        instance = this;
        sessionWorker.scheduleAtFixedRate(this::emitSessions, 0, 1, TimeUnit.SECONDS);
    }

    static void emitCaptureFrame(JSObject frame) {
        LiquidPlayerPlugin plugin = instance;
        if (plugin != null) plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners("captureFrame", frame));
    }

    static void emitCaptureState(boolean active) {
        LiquidPlayerPlugin plugin = instance;
        if (plugin != null) {
            JSObject state = new JSObject();
            state.put("active", active);
            plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners("captureState", state));
        }
    }

    @PluginMethod
    public void getUser(PluginCall call) {
        JSObject result = new JSObject();
        result.put("name", "");
        result.put("platform", "android");
        call.resolve(result);
    }

    @PluginMethod
    public void getCoverDir(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), "covers");
        dir.mkdirs();
        JSObject result = new JSObject();
        result.put("path", dir.getAbsolutePath());
        call.resolve(result);
    }

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.resolve();
            return;
        }
        Uri rootUri = data.getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                rootUri, data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            );
        } catch (SecurityException ignored) {}

        int gen = generation.incrementAndGet();
        List<DocumentFile> files = new ArrayList<>();
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), rootUri);
        scan(root, 0, files);
        files.sort((a, b) -> String.valueOf(a.getName()).compareToIgnoreCase(String.valueOf(b.getName())));

        JSArray tracks = new JSArray();
        List<String> paths = new ArrayList<>();
        for (DocumentFile file : files) {
            String path = file.getUri().toString();
            paths.add(path);
            JSObject track = new JSObject();
            track.put("path", path);
            track.put("title", fallback(file.getName()));
            track.put("artist", "");
            track.put("album", "");
            track.put("duration", 0);
            track.put("hasCover", false);
            tracks.put(track);
        }
        JSObject response = new JSObject();
        response.put("dir", root != null && root.getName() != null ? root.getName() : rootUri.toString());
        response.put("gen", gen);
        response.put("tracks", tracks);
        call.resolve(response);
        beginMetadataScan(paths, gen);
    }

    private void scan(DocumentFile dir, int depth, List<DocumentFile> out) {
        if (dir == null || depth > MAX_DEPTH || out.size() >= MAX_FILES) return;
        DocumentFile[] children = dir.listFiles();
        Arrays.sort(children, (a, b) -> String.valueOf(a.getName()).compareToIgnoreCase(String.valueOf(b.getName())));
        for (DocumentFile child : children) {
            if (out.size() >= MAX_FILES) break;
            if (child.isDirectory()) scan(child, depth + 1, out);
            else if (child.isFile() && isAudio(child.getName())) out.add(child);
        }
    }

    private boolean isAudio(String name) {
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        return dot >= 0 && AUDIO_EXT.contains(name.substring(dot).toLowerCase(Locale.ROOT));
    }

    private String fallback(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private void beginMetadataScan(List<String> paths, int gen) {
        ConcurrentLinkedQueue<JSObject> pending = new ConcurrentLinkedQueue<>();
        ScheduledExecutorService flusher = Executors.newSingleThreadScheduledExecutor();
        AtomicInteger completed = new AtomicInteger();
        flusher.scheduleAtFixedRate(() -> {
            if (generation.get() != gen) {
                flusher.shutdown();
                return;
            }
            JSArray updates = new JSArray();
            JSObject update;
            while ((update = pending.poll()) != null) updates.put(update);
            if (updates.length() > 0) {
                JSObject payload = new JSObject();
                payload.put("gen", gen);
                payload.put("updates", updates);
                notifyListeners("tracksMeta", payload);
            }
            if (pending.isEmpty() && completed.get() >= paths.size()) flusher.shutdown();
        }, 200, 200, TimeUnit.MILLISECONDS);
        for (int i = 0; i < paths.size(); i++) {
            final int index = i;
            metadataWorkers.execute(() -> {
                try {
                    if (generation.get() != gen) return;
                    JSObject update = readMetadata(paths.get(index), index);
                    if (generation.get() == gen) pending.add(update);
                } finally {
                    completed.incrementAndGet();
                }
            });
        }
    }

    private JSObject readMetadata(String path, int index) {
        JSObject update = new JSObject();
        update.put("index", index);
        update.put("title", fallback(Uri.parse(path).getLastPathSegment()));
        update.put("artist", "");
        update.put("album", "");
        update.put("duration", 0);
        update.put("hasCover", false);
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(getContext(), Uri.parse(path));
            String title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE);
            String artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
            String album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM);
            String duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (title != null && !title.isEmpty()) update.put("title", title);
            if (artist != null) update.put("artist", artist);
            if (album != null) update.put("album", album);
            if (duration != null) update.put("duration", Double.parseDouble(duration) / 1000.0);
            byte[] art = retriever.getEmbeddedPicture();
            if (art != null && saveCover(path, art)) update.put("hasCover", true);
        } catch (Exception ignored) {
        } finally {
            try { retriever.release(); } catch (Exception ignored) {}
        }
        return update;
    }

    private boolean saveCover(String uri, byte[] bytes) {
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        if (bitmap == null) return false;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        float scale = Math.min(1f, 1024f / Math.max(width, height));
        if (scale < 1f) {
            Bitmap resized = Bitmap.createScaledBitmap(bitmap, Math.round(width * scale), Math.round(height * scale), true);
            if (resized != bitmap) bitmap.recycle();
            bitmap = resized;
        }
        File dir = new File(getContext().getCacheDir(), "covers");
        dir.mkdirs();
        try (FileOutputStream stream = new FileOutputStream(new File(dir, FNV1a.hash(uri) + ".jpg"))) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, stream);
            stream.flush();
            bitmap.recycle();
            return true;
        } catch (Exception ignored) {
            bitmap.recycle();
            return false;
        }
    }

    @PluginMethod
    public void needsSessionAccess(PluginCall call) {
        sessionAccess = hasSessionAccess();
        JSObject result = new JSObject();
        result.put("required", !sessionAccess);
        call.resolve(result);
    }

    @PluginMethod
    public void requestSessionAccess(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (Exception ignored) {}
        call.resolve();
    }

    private boolean hasSessionAccess() {
        String enabled = Secure.getString(getContext().getContentResolver(), "enabled_notification_listeners");
        return enabled != null && enabled.contains(getContext().getPackageName());
    }

    @PluginMethod
    public void systemControl(PluginCall call) {
        String id = call.getString("id", "");
        String action = call.getString("action", "");
        MediaController controller = controllers.get(id);
        if (controller == null) { call.resolve(); return; }
        MediaController.TransportControls controls = controller.getTransportControls();
        switch (action) {
            case "play": controls.play(); break;
            case "pause": controls.pause(); break;
            case "toggle":
                PlaybackState state = controller.getPlaybackState();
                if (state != null && state.getState() == PlaybackState.STATE_PLAYING) controls.pause();
                else controls.play();
                break;
            case "next": controls.skipToNext(); break;
            case "prev": controls.skipToPrevious(); break;
        }
        call.resolve();
    }

    private synchronized void emitSessions() {
        if (!hasSessionAccess()) {
            if (!sessionSnapshots.isEmpty()) {
                for (Map.Entry<String, MediaController.Callback> entry : controllerCallbacks.entrySet()) {
                    MediaController controller = controllers.get(entry.getKey());
                    if (controller != null) controller.unregisterCallback(entry.getValue());
                }
                controllerCallbacks.clear();
                controllers.clear();
                sessionSnapshots.clear();
                sessionPositions.clear();
                JSObject payload = new JSObject();
                payload.put("sessions", new JSArray());
                notifyListeners("systemSessions", payload);
            }
            return;
        }
        try {
            MediaSessionManager manager = (MediaSessionManager) getContext().getSystemService(Context.MEDIA_SESSION_SERVICE);
            List<MediaController> active = manager.getActiveSessions(new ComponentName(getContext(), SessionNotificationListener.class));
            JSArray result = new JSArray();
            Map<String, MediaController> next = new HashMap<>();
            Map<String, String> snapshots = new HashMap<>();
            Map<String, Long> positions = new HashMap<>();
            boolean changed = false;
            for (MediaController controller : active) {
                String id = controller.getPackageName() + ":" + controller.getSessionToken().hashCode();
                next.put(id, controller);
                if (!controllerCallbacks.containsKey(id)) {
                    MediaController.Callback callback = new MediaController.Callback() {
                        @Override public void onMetadataChanged(MediaMetadata metadata) {
                            sessionWorker.execute(LiquidPlayerPlugin.this::emitSessions);
                        }
                        @Override public void onPlaybackStateChanged(PlaybackState state) {
                            sessionWorker.execute(LiquidPlayerPlugin.this::emitSessions);
                        }
                    };
                    controller.registerCallback(callback);
                    controllerCallbacks.put(id, callback);
                }
                MediaMetadata metadata = controller.getMetadata();
                PlaybackState state = controller.getPlaybackState();
                String title = metadata == null ? "" : metadata.getString(MediaMetadata.METADATA_KEY_TITLE);
                String artist = metadata == null ? "" : metadata.getString(MediaMetadata.METADATA_KEY_ARTIST);
                String album = metadata == null ? "" : metadata.getString(MediaMetadata.METADATA_KEY_ALBUM);
                long duration = metadata == null ? 0 : metadata.getLong(MediaMetadata.METADATA_KEY_DURATION);
                String status = state != null && state.getState() == PlaybackState.STATE_PLAYING ? "Playing"
                    : state != null && state.getState() == PlaybackState.STATE_PAUSED ? "Paused" : "Stopped";
                long position = state == null ? 0 : state.getPosition() / 1000;
                String thumb = thumbnail(metadata);
                String snapshot = title + "\u0001" + artist + "\u0001" + album + "\u0001" + status + "\u0001" + duration + "\u0001" + thumb.length();
                String previous = sessionSnapshots.get(id);
                snapshots.put(id, snapshot);
                positions.put(id, position);
                Long oldPosition = sessionPositions.get(id);
                if (!snapshot.equals(previous) || oldPosition == null || Math.abs(position - oldPosition) > 2) changed = true;
                JSObject item = new JSObject();
                item.put("id", id);
                item.put("title", title == null ? "" : title);
                item.put("artist", artist == null ? "" : artist);
                item.put("album", album == null ? "" : album);
                item.put("status", status);
                item.put("position", position);
                item.put("duration", duration / 1000.0);
                item.put("thumb", thumb);
                result.put(item);
            }
            if (!snapshots.keySet().equals(sessionSnapshots.keySet())) changed = true;
            if (changed) {
                for (String oldId : new HashSet<>(controllerCallbacks.keySet())) {
                    if (!next.containsKey(oldId)) {
                        MediaController previousController = controllers.get(oldId);
                        if (previousController != null) previousController.unregisterCallback(controllerCallbacks.remove(oldId));
                    }
                }
                controllers.clear();
                controllers.putAll(next);
                sessionSnapshots.clear();
                sessionSnapshots.putAll(snapshots);
                sessionPositions.clear();
                sessionPositions.putAll(positions);
                JSObject payload = new JSObject();
                payload.put("sessions", result);
                notifyListeners("systemSessions", payload);
            }
        } catch (SecurityException ignored) {
        } catch (Exception ignored) {}
    }

    private String thumbnail(MediaMetadata metadata) {
        if (metadata == null) return "";
        Bitmap image = metadata.getBitmap(MediaMetadata.METADATA_KEY_ART);
        if (image == null) image = metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
        if (image == null) return "";
        Bitmap scaled = Bitmap.createScaledBitmap(image, Math.min(128, image.getWidth()), Math.min(128, image.getHeight()), true);
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, output);
        if (scaled != image) scaled.recycle();
        return "data:image/jpeg;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
    }

    @PluginMethod
    public void startCapture(PluginCall call) {
        if (Build.VERSION.SDK_INT < 29) {
            JSObject result = new JSObject();
            result.put("available", false);
            call.resolve(result);
            return;
        }
        boolean needsAudio = getPermissionState("audio") != PermissionState.GRANTED;
        boolean needsNotifications = Build.VERSION.SDK_INT >= 33
            && getPermissionState("notifications") != PermissionState.GRANTED;
        if (needsAudio || needsNotifications) {
            String[] aliases = Build.VERSION.SDK_INT >= 33
                ? new String[] { "audio", "notifications" }
                : new String[] { "audio" };
            requestPermissionForAliases(aliases, call, "startProjection");
            return;
        }
        startProjection(call);
    }

    @PermissionCallback
    private void startProjection(PluginCall call) {
        if (getPermissionState("audio") != PermissionState.GRANTED) {
            JSObject result = new JSObject();
            result.put("available", false);
            call.resolve(result);
            return;
        }
        Intent intent = ((android.media.projection.MediaProjectionManager) getContext()
            .getSystemService(Context.MEDIA_PROJECTION_SERVICE)).createScreenCaptureIntent();
        startActivityForResult(call, intent, "projectionResult");
    }

    @ActivityCallback
    private void projectionResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject state = new JSObject();
            state.put("available", false);
            call.resolve(state);
            return;
        }
        Intent service = new Intent(getContext(), PlaybackCaptureService.class);
        service.putExtra("resultCode", result.getResultCode());
        service.putExtra("data", result.getData());
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(service);
        else getContext().startService(service);
        JSObject state = new JSObject();
        state.put("available", true);
        call.resolve(state);
    }

    @PluginMethod
    public void stopCapture(PluginCall call) {
        getContext().stopService(new Intent(getContext(), PlaybackCaptureService.class));
        call.resolve();
    }
}
