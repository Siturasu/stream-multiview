import Foundation

/// Playback evidence excludes the known CHZZK ad endpoint. This is not a
/// universal ad detector: new ad delivery URLs still need device observation.
enum ChzzkPlaybackEvidence {
    // Keep identity across samples, but replace it when an element's source
    // changes. Never compare the playheads of two different videos/sources.
    static let probeScript = #"""
    const identities = globalThis.__svHarnessVideos ||= { entries: new WeakMap(), next: 0 };
    const videos = [...document.querySelectorAll("video")].map((v) => {
      const source = v.currentSrc || "";
      let identity = identities.entries.get(v);
      if (!identity || identity.source !== source) {
        identity = { source, id: `${performance.timeOrigin}:${++identities.next}` };
        identities.entries.set(v, identity);
      }
      let isKnownAd = false;
      let safeSource = "";
      if (source) {
        try {
          const url = new URL(source, location.href);
          isKnownAd = url.hostname === "api.chzzk.naver.com" && url.pathname.startsWith("/service/t/");
          safeSource = url.protocol === "data:" ? "data:[inline media]" :
            `${url.protocol}//${url.host}${url.pathname}`.slice(0, 120);
        } catch { safeSource = "unparsed-source"; }
      }
      return {
        id: identity.id, isKnownAd,
        paused: v.paused, muted: v.muted, readyState: v.readyState,
        width: v.videoWidth, height: v.videoHeight,
        currentTime: Math.round(v.currentTime * 10) / 10,
        src: safeSource,
      };
    });
    """#

    static func videos(_ probe: Any?) -> [[String: Any]] {
        (probe as? [String: Any])?["videos"] as? [[String: Any]] ?? []
    }

    static func contentVideos(_ probe: Any?, requireAudio: Bool = false) -> [[String: Any]] {
        videos(probe).filter {
            $0["isKnownAd"] as? Bool == false &&
            !(($0["id"] as? String) ?? "").isEmpty &&
            !(($0["src"] as? String) ?? "").isEmpty &&
            (($0["width"] as? Int) ?? 0) > 0 &&
            (($0["readyState"] as? Int) ?? 0) >= 2 &&
            $0["paused"] as? Bool == false &&
            (!requireAudio || $0["muted"] as? Bool == false)
        }
    }

    static func progress(from first: Any?, to second: Any?, requireAudio: Bool = false) -> [String: Any]? {
        let previous = contentVideos(first, requireAudio: requireAudio)
        for video in contentVideos(second, requireAudio: requireAudio) {
            guard let id = video["id"] as? String,
                  let baseline = previous.first(where: { $0["id"] as? String == id }),
                  let before = baseline["currentTime"] as? Double,
                  let after = video["currentTime"] as? Double,
                  after - before >= 1 else { continue }
            return ["videoId": id, "advancedSeconds": after - before, "first": baseline, "second": video]
        }
        return nil
    }
}
