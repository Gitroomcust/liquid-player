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
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.IBinder;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

public class PlaybackCaptureService extends Service {
    private volatile boolean running;
    private AudioRecord recorder;
    private MediaProjection projection;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (Build.VERSION.SDK_INT < 29 || intent == null) { stopSelf(); return START_NOT_STICKY; }
        createNotification();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(41, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        } else {
            startForeground(41, notification());
        }
        int resultCode = intent.getIntExtra("resultCode", 0);
        Intent resultData = intent.getParcelableExtra("data");
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(resultCode, resultData);
        if (projection == null) { stopSelf(); return START_NOT_STICKY; }

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
        recorder = new AudioRecord.Builder().setAudioFormat(format).setBufferSizeInBytes(buffer).setAudioPlaybackCaptureConfig(config).build();
        recorder.startRecording();
        running = true;
        LiquidPlayerPlugin.emitCaptureState(true);
        new Thread(this::readAudio, "liquid-player-capture").start();
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

    private void readAudio() {
        short[] samples = new short[2048];
        while (running && recorder != null) {
            int read = recorder.read(samples, 0, samples.length);
            if (read <= 0) continue;
            JSObject frame = new JSObject();
            frame.put("frequencyData", fft(samples, read));
            LiquidPlayerPlugin.emitCaptureFrame(frame);
        }
    }

    private JSArray fft(short[] samples, int length) {
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
        JSArray values = new JSArray();
        for (int i = 0; i < n / 2; i++) {
            double magnitude = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (n / 2.0);
            double db = 20 * Math.log10(Math.max(magnitude, 1e-8));
            int value = (int) Math.max(0, Math.min(255, Math.round((db + 100) * (255.0 / 70.0))));
            values.put(value);
        }
        return values;
    }

    @Override
    public void onDestroy() {
        running = false;
        if (recorder != null) { recorder.stop(); recorder.release(); recorder = null; }
        if (projection != null) { projection.stop(); projection = null; }
        LiquidPlayerPlugin.emitCaptureState(false);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
