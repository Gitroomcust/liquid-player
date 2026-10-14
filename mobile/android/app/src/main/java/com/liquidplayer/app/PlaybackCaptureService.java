package com.liquidplayer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;
import android.util.Base64;

import com.getcapacitor.JSObject;

public class PlaybackCaptureService extends Service {
    private volatile boolean running;
    private AudioRecord recorder;
    private MediaProjection projection;
    private Thread readerThread;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT < 29 || intent == null) {
            failCaptureStart();
            return START_NOT_STICKY;
        }
        createNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(41, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(41, notification());
        }
        int resultCode = intent.getIntExtra("resultCode", 0);
        Intent resultData = intent.getParcelableExtra("data");
        try {
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(resultCode, resultData);
            if (projection == null) {
                failCaptureStart();
                return START_NOT_STICKY;
            }

            AudioPlaybackCaptureConfiguration config = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build();
            int sampleRate = 48000;
            AudioFormat format = new AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(sampleRate)
                .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                .build();
            int buffer = Math.max(AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT), 4096);
            recorder = new AudioRecord.Builder()
                .setAudioFormat(format)
                .setBufferSizeInBytes(buffer)
                .setAudioPlaybackCaptureConfig(config)
                .build();
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) {
                failCaptureStart();
                return START_NOT_STICKY;
            }
            recorder.startRecording();
        } catch (Exception ignored) {
            failCaptureStart();
            return START_NOT_STICKY;
        }

        running = true;
        LiquidPlayerPlugin.emitCaptureState(true);
        AudioRecord activeRecorder = recorder;
        readerThread = new Thread(() -> readAudio(activeRecorder), "liquid-player-capture");
        readerThread.start();
        return START_NOT_STICKY;
    }

    private Notification notification() {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel("capture", "Анализ звука", NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, "capture") : new Notification.Builder(this);
        return builder.setContentTitle("Liquid Player")
            .setContentText("Анализ системного звука")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .build();
    }

    private void createNotification() { notification(); }

    private void failCaptureStart() {
        running = false;
        LiquidPlayerPlugin.emitCaptureState(false);
        stopSelf();
    }

    private void readAudio(AudioRecord activeRecorder) {
        short[] samples = new short[2048];
        while (running) {
            int read;
            try {
                read = activeRecorder.read(samples, 0, samples.length);
            } catch (IllegalStateException ignored) {
                break;
            }
            if (!running) break;
            if (read < 0) break;
            if (read <= 0) continue;
            JSObject frame = new JSObject();
            frame.put("frequency", Base64.encodeToString(fft(samples, read), Base64.NO_WRAP));
            LiquidPlayerPlugin.emitCaptureFrame(frame);
        }
    }

    private byte[] fft(short[] samples, int length) {
        int n = 2048;
        double[] real = new double[n];
        double[] imag = new double[n];
        for (int i = 0; i < n; i++) {
            double sample = i < length ? samples[i] / 32768.0 : 0;
            real[i] = sample * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
        }
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                double swap = real[i]; real[i] = real[j]; real[j] = swap;
            }
        }
        for (int size = 2; size <= n; size <<= 1) {
            double angle = -2 * Math.PI / size;
            double wr0 = Math.cos(angle);
            double wi0 = Math.sin(angle);
            for (int start = 0; start < n; start += size) {
                double wr = 1;
                double wi = 0;
                for (int k = 0; k < size / 2; k++) {
                    int even = start + k;
                    int odd = even + size / 2;
                    double tr = wr * real[odd] - wi * imag[odd];
                    double ti = wr * imag[odd] + wi * real[odd];
                    real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
                    real[even] += tr; imag[even] += ti;
                    double next = wr * wr0 - wi * wi0;
                    wi = wr * wi0 + wi * wr0;
                    wr = next;
                }
            }
        }
        byte[] values = new byte[n / 2];
        for (int i = 0; i < n / 2; i++) {
            double magnitude = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (n / 2.0);
            double db = 20 * Math.log10(Math.max(magnitude, 1e-8));
            int value = (int) Math.max(0, Math.min(255, Math.round((db + 100) * (255.0 / 70.0))));
            values[i] = (byte) value;
        }
        return values;
    }

    @Override
    public void onDestroy() {
        running = false;
        Thread reader = readerThread;
        if (reader != null && reader != Thread.currentThread()) {
            try {
                reader.join(500);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
        readerThread = null;
        if (recorder != null) {
            try {
                if (recorder.getState() == AudioRecord.STATE_INITIALIZED
                    && recorder.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) {
                    recorder.stop();
                }
            } catch (IllegalStateException ignored) {}
            recorder.release();
            recorder = null;
        }
        if (projection != null) {
            try { projection.stop(); } catch (IllegalStateException ignored) {}
            projection = null;
        }
        LiquidPlayerPlugin.emitCaptureState(false);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
