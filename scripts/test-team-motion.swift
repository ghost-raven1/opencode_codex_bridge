import AppKit

@main struct TeamTests {
    static func member(_ id: String, parent: String? = nil, invocation: String = "one", state: String = "working") -> Character {
        Character(id: id, column: 0, label: id, state: state, parentID: parent, invocationID: invocation)
    }
    static func main() {
        _ = NSApplication.shared
        var team = TeamCoordinator()
        team.observe(member("parent"), at: 0)
        precondition(team.actions.isEmpty, "A solo character invented a teammate")
        team.observe(member("child", parent: "parent"), at: 1, entranceDelay: 1.65)
        precondition(team.actions.count == 1 && team.actions[0].kind == .handoff)
        precondition(team.action(for: "child", at: 2) == nil, "Handoff started before entrance finished")
        for time in [1.1, 1.5, 2.0] { team.observe(member("child", parent: "parent"), at: time) }
        precondition(team.actions.count == 1, "Repeated metadata replayed a handoff")
        team.observe(member("child", parent: "parent", state: "success"), at: 3)
        precondition(team.actions.count == 2 && team.actions[1].kind == .result)
        precondition(team.actions[1].start >= team.actions[0].end, "Two gestures overlapped on a participant")
        precondition(team.actions[1].source == "child" && team.actions[1].target == "parent")
        team.observe(member("child", parent: "parent", state: "success"), at: 3.1)
        precondition(team.actions.count == 2)
        let oldEnd = team.actions.last!.end
        team.tick(at: oldEnd + 1); precondition(team.actions.isEmpty)
        team.observe(member("child", parent: "parent", state: "success"), at: oldEnd + 2)
        precondition(team.actions.isEmpty, "A late terminal event revived the reaction")
        team.observe(member("child", parent: "parent", invocation: "two"), at: oldEnd + 3)
        precondition(team.actions.count == 1 && team.actions[0].kind == .handoff)
        team.observe(member("child", parent: "parent", invocation: "two", state: "error"), at: oldEnd + 4)
        precondition(team.actions.last!.kind == .support && team.actions.last!.source == "parent")
        team.remove("parent"); precondition(team.actions.isEmpty)

        // Delayed parent and delayed metadata both reach the same linked handoff.
        var late = TeamCoordinator()
        late.observe(member("child", parent: "parent"), at: 0)
        precondition(late.actions.isEmpty)
        late.observe(member("parent"), at: 2)
        precondition(late.actions.filter { $0.kind == .handoff }.count == 1)
        late.reset(); late.observe(member("parent"), at: 0)
        late.observe(member("child"), at: 1)
        precondition(late.actions.first?.kind == .greeting)
        late.observe(member("child", parent: "parent"), at: 2)
        precondition(late.actions.filter { $0.kind == .handoff }.count == 1)
        late.observe(member("child", parent: "parent", invocation: "new"), at: 2.1)
        precondition(late.actions.count == 1, "New task retained old queued actions")
        for n in 0..<50 { late.observe(member("peer-\(n)"), at: 2.2) }
        precondition(late.actions.count <= 8, "Interaction queue is unbounded")
        late.reset(); late.observe(member("parent"), at: 0, animated: false)
        late.observe(member("child", parent: "parent"), at: 0, animated: false)
        late.observe(member("child", parent: "parent"), at: 1)
        precondition(late.actions.isEmpty, "Restoring characters replayed an old handoff")
        late.remove("child"); late.observe(member("child", parent: "parent"), at: 2)
        precondition(late.actions.isEmpty, "Visual eviction replayed the same invocation's handoff")
        late.observe(member("child", parent: "parent", invocation: "next"), at: 3)
        precondition(late.actions.count == 1, "A fresh invocation lost its handoff after eviction")

        // Fast tasks report their result rather than accepting an assignment after completion.
        var fast = TeamCoordinator()
        fast.observe(member("parent"), at: 0)
        fast.observe(member("child", parent: "parent"), at: 1, entranceDelay: 1.65)
        fast.observe(member("child", parent: "parent", state: "success"), at: 1.1, entranceDelay: 1.55)
        precondition(fast.actions.map(\.kind) == [.result], "Completed child retained an unstarted handoff")
        precondition(fast.actions[0].start >= 2.65, "Result began before the child appeared")
        fast.observe(member("child", parent: "parent", state: "success"), at: 1.2)
        precondition(fast.actions.count == 1, "Repeated completion duplicated a queued result")

        var entering = TeamCoordinator()
        entering.observe(member("child", parent: "parent"), at: 1, entranceDelay: 1.65)
        entering.observe(member("parent"), at: 1.1)
        precondition(entering.actions[0].start >= 2.65, "Late parent metadata ignored the child's entrance time")

        // A result rejected by the six-second horizon must retry without another metadata event.
        var busy = TeamCoordinator()
        busy.observe(member("parent"), at: 0)
        for id in ["child-a", "child-b", "child-c"] { busy.observe(member(id, parent: "parent"), at: 1) }
        busy.observe(member("child-a", parent: "parent", state: "success"), at: 1.2)
        precondition(!busy.actions.contains { $0.kind == .result }, "Fixture did not fill the scheduling horizon")
        let freedAt = busy.actions.map(\.end).max()! + 1
        busy.tick(at: freedAt)
        precondition(busy.actions.contains { $0.kind == .result && $0.source == "child-a" }, "Busy parent lost a deferred result")
        let resultEnd = busy.actions.last!.end
        busy.tick(at: resultEnd + 1); busy.tick(at: resultEnd + 2)
        precondition(busy.actions.isEmpty, "Consumed reactions replayed on render ticks")

        var stale = TeamCoordinator()
        stale.observe(member("parent"), at: 0)
        for id in ["child-a", "child-b", "child-c"] { stale.observe(member(id, parent: "parent"), at: 1) }
        stale.observe(member("child-a", parent: "parent", state: "success"), at: 1.2)
        var evicted = stale
        evicted.remove("child-a")
        evicted.observe(member("parent", invocation: "next"), at: 1.3)
        evicted.observe(member("child-a", parent: "parent", state: "success"), at: 2)
        evicted.tick(at: 10)
        precondition(evicted.actions.isEmpty, "Evicted child delivered an old result to a new parent invocation")
        stale.observe(member("parent", invocation: "next"), at: 1.3)
        stale.tick(at: 10)
        precondition(stale.actions.isEmpty, "Old child delivered a deferred result to a new parent invocation")

        var reconnect = TeamCoordinator()
        reconnect.observe(member("parent"), at: 0)
        reconnect.observe(member("child", parent: "parent"), at: 1, entranceDelay: 1.65)
        reconnect.observe(member("parent"), at: 1.1, animated: false)
        reconnect.observe(member("child", parent: "parent"), at: 1.1, animated: false)
        reconnect.tick(at: 2)
        precondition(reconnect.actions.isEmpty, "Silent restoration retained old queued interactions")

        for kind in [TeamActionKind.greeting, .handoff, .result, .support] {
            let action = TeamAction(kind: kind, source: "parent", target: "child", start: 0)
            for role in ["lead", "code", "research", "review", "designer", "devops", "tester"] {
                for id in ["parent", "child"] {
                    var frames = Set<String>()
                    for n in 0...120 {
                        let time = Double(n) / 120 * kind.duration
                        let pose = TeamMotion.pose(action, id: id, rig: role, direction: id == "parent" ? 1 : -1, at: time, reduced: false)
                        precondition(abs(pose.headX) <= 0.81 && abs(pose.headY) <= 0.81 && abs(pose.bodyAngle) <= 0.81)
                        precondition(pose.joints.values.allSatisfy { abs($0.angle) <= 2 && $0.x == 0 && $0.y == 0 })
                        frames.insert("\(pose.headX):\(pose.headY):\(pose.bodyAngle):\(pose.joints)")
                    }
                    precondition(frames.count > 60, "Interaction repeated only a few poses")
                    let calm = TeamMotion.pose(action, id: id, rig: role, direction: 1, at: 1, reduced: true)
                    precondition(calm.joints.isEmpty && calm.bodyAngle == 0)
                }
            }
        }
        for kind in [TeamActionKind.greeting, .support, .handoff, .result] {
            let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 300, pixelsHigh: 220,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0)!
            memset(bitmap.bitmapData!, 0, bitmap.bytesPerRow * bitmap.pixelsHigh)
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
            TeamMotion.draw([TeamAction(kind: kind, source: "a", target: "b", start: 0)],
                centers: ["a": NSPoint(x: 70, y: 70), "b": NSPoint(x: 230, y: 70)], colors: ["a": .systemPink], time: kind.duration / 2, reduced: false)
            NSGraphicsContext.restoreGraphicsState()
            let count = stride(from: 3, to: bitmap.bytesPerRow * bitmap.pixelsHigh, by: 4).filter { bitmap.bitmapData![$0] > 0 }.count
            print("Team overlay \(kind): \(count) coloured pixels")
            precondition(count > 10, "Team overlay failed to draw \(kind)")
        }
        print("PASS linked handoffs, results, support, greetings, event deduplication, bounded serial actions, interruption, restoration and 56 paired role gestures")
    }
}
