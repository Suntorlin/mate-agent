import React from "react";
import { Composition, registerRoot } from "remotion";
import { Main } from "./Main";

const Root: React.FC = () =>
  React.createElement(Composition, {
    id: "Main",
    component: Main,
    durationInFrames: 57 * 24,
    fps: 24,
    width: 1280,
    height: 720,
  });

registerRoot(Root);
