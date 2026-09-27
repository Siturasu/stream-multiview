import Foundation

func video(_ id: String = "content", time: Double, ad: Bool = false, muted: Bool = true, paused: Bool = false) -> [String: Any] {
    ["id": id, "currentTime": time, "isKnownAd": ad, "muted": muted, "paused": paused,
     "readyState": 4, "width": 1920, "src": "blob:https://chzzk.naver.com/video"]
}
func probe(_ videos: [String: Any]...) -> [String: Any] { ["videos": videos] }
var checks = 0
func check(_ label: String, _ condition: Bool) {
    guard condition else { fatalError(label) }
    checks += 1
    print("ok: \(label)")
}
let progress = ChzzkPlaybackEvidence.progress
check("content advances", progress(probe(video(time: 10)), probe(video(time: 12)), false) != nil)
check("ad-only playback cannot pass", progress(probe(video(time: 1, ad: true)), probe(video(time: 3, ad: true)), false) == nil)
check("paused content and advancing ad cannot pass", progress(
    probe(video(time: 40, paused: true), video("ad", time: 1, ad: true)),
    probe(video(time: 40, paused: true), video("ad", time: 3, ad: true)), false) == nil)
check("longer ad playhead does not hide content progress", progress(
    probe(video(time: 10), video("ad", time: 100, ad: true)),
    probe(video(time: 12), video("ad", time: 100, ad: true)), false) != nil)
check("different element or source cannot pass", progress(probe(video("old", time: 1)), probe(video("new", time: 30)), false) == nil)
check("stalled content cannot pass", progress(probe(video(time: 10)), probe(video(time: 10)), false) == nil)
check("muted content cannot pass audio check", progress(probe(video(time: 10)), probe(video(time: 12)), true) == nil)
check("unmuted ad cannot pass audio check", progress(probe(video(time: 1, ad: true, muted: false)), probe(video(time: 3, ad: true, muted: false)), true) == nil)
check("unmuted content advances", progress(probe(video(time: 10, muted: false)), probe(video(time: 12, muted: false)), true) != nil)
check("unreachable frame cannot pass", progress(nil, probe(video(time: 12)), false) == nil)
check("ad-to-content transition needs a fresh baseline", progress(probe(video(time: 1, ad: true)), probe(video(time: 50)), false) == nil)
check("backward playhead cannot pass", progress(probe(video(time: 100)), probe(video(time: 1)), false) == nil)
print("\(checks) playback checks passed")
