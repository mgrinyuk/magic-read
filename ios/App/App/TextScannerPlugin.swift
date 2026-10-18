import Foundation
import Capacitor
import UIKit
import PhotosUI
import Vision

/// Reads the text off a page: the user takes a photo or picks one, and Apple's
/// on-device Vision recognizer returns it. Nothing leaves the phone.
///
/// scan({ languages: ["zh"] }) shows a "Take photo / Choose photo" sheet and
/// resolves { text } — one recognized line per row, top to bottom. The web
/// layer joins the lines back into sentences. Cancelling resolves { text: "" }.
///
/// Registered by hand in MyViewController.capacitorDidLoad(); Capacitor only
/// auto-registers plugins that ship as packages.
@objc(TextScannerPlugin)
public class TextScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TextScannerPlugin"
    public let jsName = "TextScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
    ]

    private var pendingCall: CAPPluginCall?
    private var languages: [String] = []

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func scan(_ call: CAPPluginCall) {
        if pendingCall != nil {
            call.reject("A scan is already in progress.")
            return
        }
        pendingCall = call
        languages = Self.visionLanguages(for: call.getArray("languages", String.self) ?? [])

        DispatchQueue.main.async {
            guard let presenter = self.bridge?.viewController else {
                self.finish(error: "No screen to show the camera on.")
                return
            }
            let sheet = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                sheet.addAction(UIAlertAction(title: "Take photo", style: .default) { _ in
                    self.presentCamera(from: presenter)
                })
            }
            sheet.addAction(UIAlertAction(title: "Choose photo", style: .default) { _ in
                self.presentLibrary(from: presenter)
            })
            sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
                self.finish(text: "")
            })
            // iPad shows action sheets as popovers, which need an anchor.
            if let popover = sheet.popoverPresentationController {
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.maxY - 120, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            presenter.present(sheet, animated: true)
        }
    }

    private func presentCamera(from presenter: UIViewController) {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func presentLibrary(from presenter: UIViewController) {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func recognize(_ image: UIImage) {
        guard let cgImage = image.cgImage else {
            finish(error: "Could not read that photo.")
            return
        }
        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                self.finish(error: error.localizedDescription)
                return
            }
            let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
            let lines = observations.compactMap { $0.topCandidates(1).first?.string }
            self.finish(text: lines.joined(separator: "\n"))
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if !languages.isEmpty {
            let supported = (try? request.supportedRecognitionLanguages()) ?? []
            let usable = languages.filter { supported.contains($0) }
            if !usable.isEmpty { request.recognitionLanguages = usable }
        }

        let orientation = CGImagePropertyOrientation(image.imageOrientation)
        DispatchQueue.global(qos: .userInitiated).async {
            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            do {
                try handler.perform([request])
            } catch {
                self.finish(error: error.localizedDescription)
            }
        }
    }

    private func finish(text: String) {
        pendingCall?.resolve(["text": text])
        pendingCall = nil
    }

    private func finish(error: String) {
        pendingCall?.reject(error)
        pendingCall = nil
    }

    /// The app's language codes → Vision's. Chinese lists both scripts so
    /// traditional-character texts are read too.
    private static func visionLanguages(for codes: [String]) -> [String] {
        let map: [String: [String]] = [
            "zh": ["zh-Hans", "zh-Hant"],
            "ja": ["ja-JP"],
            "ko": ["ko-KR"],
            "en": ["en-US"],
            "de": ["de-DE"],
            "fr": ["fr-FR"],
            "es": ["es-ES"],
            "it": ["it-IT"],
            "pt": ["pt-BR"],
            "ru": ["ru-RU"],
            "uk": ["uk-UA"],
            "tr": ["tr-TR"]
        ]
        var out: [String] = []
        for code in codes {
            for lang in map[code.lowercased()] ?? [] where !out.contains(lang) {
                out.append(lang)
            }
        }
        return out
    }
}

extension TextScannerPlugin: UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    public func imagePickerController(_ picker: UIImagePickerController,
                                      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        guard let image = info[.originalImage] as? UIImage else {
            finish(error: "Could not read that photo.")
            return
        }
        recognize(image)
    }

    public func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        finish(text: "")
    }
}

extension TextScannerPlugin: PHPickerViewControllerDelegate {
    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
            finish(text: "")
            return
        }
        provider.loadObject(ofClass: UIImage.self) { object, _ in
            guard let image = object as? UIImage else {
                self.finish(error: "Could not read that photo.")
                return
            }
            self.recognize(image)
        }
    }
}

private extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .upMirrored: self = .upMirrored
        case .down: self = .down
        case .downMirrored: self = .downMirrored
        case .left: self = .left
        case .leftMirrored: self = .leftMirrored
        case .right: self = .right
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
