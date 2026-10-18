package com.magicread.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import java.io.File;
import java.io.IOException;

/**
 * Reads the text off a page: the user takes a photo or picks one, and Google's
 * on-device ML Kit recognizer returns it. Nothing leaves the phone.
 *
 * Same contract as the iOS plugin: scan({ languages: ["zh"], labels }) shows a
 * "Take photo / Choose photo" dialog and resolves { text }, one recognized line
 * per row. Cancelling resolves { text: "" }.
 *
 * ML Kit reads Latin, Chinese and Japanese script but not Cyrillic, so Russian
 * rejects with code UNSUPPORTED_LANGUAGE.
 *
 * The camera goes through the system camera app (ACTION_IMAGE_CAPTURE), which
 * needs no CAMERA permission as long as the app doesn't declare one.
 */
@CapacitorPlugin(name = "TextScanner")
public class TextScannerPlugin extends Plugin {
    private File photoFile;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void scan(PluginCall call) {
        String language = firstLanguage(call);
        if ("ru".equals(language) || "uk".equals(language)) {
            call.reject("Scanning this language isn't supported on Android yet.", "UNSUPPORTED_LANGUAGE");
            return;
        }

        JSObject labels = call.getObject("labels", new JSObject());
        String take = labels.getString("takePhoto", "Take photo");
        String choose = labels.getString("choosePhoto", "Choose photo");
        String cancel = labels.getString("cancel", "Cancel");

        getActivity().runOnUiThread(() -> {
            boolean hasCamera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE)
                .resolveActivity(getContext().getPackageManager()) != null;
            String[] options = hasCamera ? new String[] { take, choose } : new String[] { choose };

            new AlertDialog.Builder(getActivity())
                .setItems(options, (dialog, which) -> {
                    if (hasCamera && which == 0) openCamera(call);
                    else openPicker(call);
                })
                .setNegativeButton(cancel, (dialog, which) -> resolveText(call, ""))
                .setOnCancelListener(dialog -> resolveText(call, ""))
                .show();
        });
    }

    private void openCamera(PluginCall call) {
        try {
            photoFile = File.createTempFile("scan-", ".jpg", getContext().getCacheDir());
        } catch (IOException e) {
            call.reject("Could not prepare the camera.");
            return;
        }
        Uri uri = FileProvider.getUriForFile(
            getContext(), getContext().getPackageName() + ".fileprovider", photoFile);
        Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        intent.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(call, intent, "cameraResult");
        } catch (ActivityNotFoundException e) {
            call.reject("No camera app found.");
        }
    }

    private void openPicker(PluginCall call) {
        PickVisualMediaRequest request = new PickVisualMediaRequest.Builder()
            .setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE)
            .build();
        Intent intent = new ActivityResultContracts.PickVisualMedia().createIntent(getContext(), request);
        startActivityForResult(call, intent, "pickerResult");
    }

    @ActivityCallback
    private void cameraResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        File file = photoFile;
        photoFile = null;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || file == null || file.length() == 0) {
            if (file != null) file.delete();
            resolveText(call, "");
            return;
        }
        recognize(call, Uri.fromFile(file), file);
    }

    @ActivityCallback
    private void pickerResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (result.getResultCode() != android.app.Activity.RESULT_OK || uri == null) {
            resolveText(call, "");
            return;
        }
        recognize(call, uri, null);
    }

    private void recognize(PluginCall call, Uri uri, File cleanup) {
        InputImage image;
        try {
            // fromFilePath reads the EXIF orientation, so sideways photos work.
            image = InputImage.fromFilePath(getContext(), uri);
        } catch (IOException e) {
            if (cleanup != null) cleanup.delete();
            call.reject("Could not read that photo.");
            return;
        }

        TextRecognizer recognizer = recognizerFor(firstLanguage(call));
        recognizer.process(image)
            .addOnSuccessListener(text -> resolveText(call, text.getText()))
            .addOnFailureListener(e -> call.reject("Could not read text from that photo.", e))
            .addOnCompleteListener(task -> {
                recognizer.close();
                if (cleanup != null) cleanup.delete();
            });
    }

    private static TextRecognizer recognizerFor(String language) {
        if ("zh".equals(language)) {
            return TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        }
        if ("ja".equals(language)) {
            return TextRecognition.getClient(new JapaneseTextRecognizerOptions.Builder().build());
        }
        return TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    private static String firstLanguage(PluginCall call) {
        try {
            String lang = call.getArray("languages").getString(0);
            return lang == null ? "" : lang.toLowerCase();
        } catch (Exception e) {
            return "";
        }
    }

    private static void resolveText(PluginCall call, String text) {
        JSObject ret = new JSObject();
        ret.put("text", text == null ? "" : text);
        call.resolve(ret);
    }
}
