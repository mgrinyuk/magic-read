package com.magicread.app;

import android.os.CancellationSignal;

import androidx.annotation.NonNull;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.libraries.identity.googleid.GetGoogleIdOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;

import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "GoogleAuth")
public class GoogleAuthPlugin extends Plugin {
    private CredentialManager credentialManager;
    private final Executor executor = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        credentialManager = CredentialManager.create(getContext());
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        String serverClientId = call.getString("serverClientId");
        if (serverClientId == null || serverClientId.trim().isEmpty()) {
            call.reject("Missing Google web client ID.");
            return;
        }

        GetGoogleIdOption googleIdOption = new GetGoogleIdOption.Builder()
            .setFilterByAuthorizedAccounts(false)
            .setServerClientId(serverClientId)
            .setAutoSelectEnabled(false)
            .build();

        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build();

        credentialManager.getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            executor,
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse result) {
                    handleCredentialResult(call, result);
                }

                @Override
                public void onError(@NonNull GetCredentialException e) {
                    String message = e.getMessage() == null ? "Google Sign-In failed." : e.getMessage();
                    call.reject(message, e.getType());
                }
            }
        );
    }

    private void handleCredentialResult(PluginCall call, GetCredentialResponse result) {
        Credential credential = result.getCredential();
        if (!(credential instanceof CustomCredential)) {
            call.reject("Google Sign-In returned an unsupported credential.");
            return;
        }

        CustomCredential customCredential = (CustomCredential) credential;
        if (!GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(customCredential.getType())) {
            call.reject("Google Sign-In returned an unsupported credential type.");
            return;
        }

        try {
            GoogleIdTokenCredential googleCredential =
                GoogleIdTokenCredential.createFrom(customCredential.getData());
            JSObject response = new JSObject();
            response.put("idToken", googleCredential.getIdToken());
            response.put("id", googleCredential.getId());
            response.put("displayName", googleCredential.getDisplayName());
            response.put("givenName", googleCredential.getGivenName());
            response.put("familyName", googleCredential.getFamilyName());
            response.put("phoneNumber", googleCredential.getPhoneNumber());
            response.put("profilePictureUri", googleCredential.getProfilePictureUri());
            call.resolve(response);
        } catch (Exception error) {
            call.reject("Could not read Google credential.", error);
        }
    }
}
