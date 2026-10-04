/** One production renderer is shared by the app, regression tests and visual QA. */
export const rendererSources = [
  "AnimationContract.swift", "CharacterView.swift", "SpriteTransition.swift", "IdleMotion.swift", "TeamMotion.swift",
  "CharacterMotion.swift", "LayeredMotion.swift", "LayeredRig.swift", "SkeletalRig.swift", "SkeletalMotion.swift", "SkeletalGestures.swift", "WorkMotion.swift", "ActionMotion.swift", "StateMotion.swift",
  "PoseAnimation.swift", "PoseChoreography.swift", "MusicRhythm.swift", "MusicMotion.swift",
  "CharacterBadgeView.swift", "SpeechBubbleView.swift", "SpriteCache.swift", "SpriteDepth.swift",
];

/** Resolve the small dependencies of isolated native test groups. */
export function nativeTestSources(sources) {
  return [...new Set([...sources,
    ...(sources.includes("WorkMotion.swift") ? ["ActionMotion.swift", "AnimationContract.swift", "SkeletalGestures.swift"] : []),
    ...(sources.includes("TeamMotion.swift") ? ["MusicMotion.swift", "MusicRhythm.swift"] : []),
    ...(sources.includes("LayeredRig.swift") ? ["SkeletalRig.swift"] : []),
    ...(sources.includes("SkeletalMotion.swift") ? ["MusicRhythm.swift", "MusicMotion.swift", "AnimationContract.swift"] : []),
    ...(sources.includes("PoseAnimation.swift") ? ["PoseChoreography.swift", "MusicRhythm.swift"] : []),
    ...(sources.some(name => ["PoseAnimation.swift", "CharacterMotion.swift", "LayeredRig.swift", "SpriteCache.swift"].includes(name))
      ? ["AnimationContract.swift"] : []),
  ])];
}
