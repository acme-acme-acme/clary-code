import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/**
 * Code-bracket mark for Otter Code's own activity rows, matching the web
 * T3Wordmark SVG.
 */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg
      accessibilityLabel="Otter Code"
      height={props.height}
      width={props.height}
      viewBox="0 0 24 24"
    >
      <ThemedPath
        d="M8.6 5.2 1.8 12l6.8 6.8 2.1-2.1L6 12l4.7-4.7ZM15.4 5.2l6.8 6.8-6.8 6.8-2.1-2.1L18 12l-4.7-4.7Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
