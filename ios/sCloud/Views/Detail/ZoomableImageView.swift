import SwiftUI
import UIKit

/// UIScrollView-based zoomable image view. Provides proper pinch-to-zoom
/// with bounce, double-tap to toggle fit/fill, and momentum pan.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate                       = context.coordinator
        scroll.minimumZoomScale               = 1.0
        scroll.maximumZoomScale               = 8.0
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator   = false
        scroll.bouncesZoom                    = true
        scroll.backgroundColor                = .black

        let imageView = UIImageView(image: image)
        imageView.contentMode   = .scaleAspectFit
        imageView.clipsToBounds = true
        scroll.addSubview(imageView)

        context.coordinator.imageView = imageView
        context.coordinator.scrollView = scroll

        // Double-tap to zoom
        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)

        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        guard let imageView = context.coordinator.imageView else { return }
        imageView.image = image

        // Layout the imageView to fill the scroll content, centred
        let size = scroll.bounds.size
        guard size.width > 0, size.height > 0 else { return }

        let imgSize = image.size
        guard imgSize.width > 0, imgSize.height > 0 else { return }

        let scale = min(size.width / imgSize.width, size.height / imgSize.height)
        let fittedW = imgSize.width  * scale
        let fittedH = imgSize.height * scale
        imageView.frame = CGRect(x: (size.width - fittedW) / 2,
                                 y: (size.height - fittedH) / 2,
                                 width: fittedW, height: fittedH)
        scroll.contentSize = size
        context.coordinator.layoutImage()
    }

    // ── Coordinator ───────────────────────────────────────────────────────────

    class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?
        weak var scrollView: UIScrollView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) { layoutImage() }

        func layoutImage() {
            guard let scroll = scrollView, let iv = imageView else { return }
            let offsetX = max((scroll.bounds.width  - iv.frame.width)  / 2, 0)
            let offsetY = max((scroll.bounds.height - iv.frame.height) / 2, 0)
            iv.center = CGPoint(x: scroll.contentSize.width  / 2 + offsetX,
                                y: scroll.contentSize.height / 2 + offsetY)
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll = scrollView else { return }
            if scroll.zoomScale > scroll.minimumZoomScale {
                scroll.setZoomScale(scroll.minimumZoomScale, animated: true)
            } else {
                let point = gesture.location(in: gesture.view)
                let zoomRect = CGRect(x: point.x - 40, y: point.y - 60, width: 80, height: 120)
                scroll.zoom(to: zoomRect, animated: true)
            }
        }
    }
}
