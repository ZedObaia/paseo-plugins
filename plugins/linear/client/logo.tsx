import { Icon } from "@getpaseo/plugin/client/react-native";
import { Image } from "react-native";

// Linear's mark, from Simple Icons (CC0 1.0): https://simpleicons.org/?q=linear
const MARK =
  "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z";

const uri = (color: string) =>
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${MARK}"/></svg>`,
  );

export function LinearLogo({ size, color, platform }: { size: number; color: string; platform: string }) {
  // React Native only draws SVG images on web: phones get a stand-in
  if (platform !== "web") return <Icon name="SquareKanban" size={size} color={color} />;
  return (
    <Image
      source={{ uri: uri(color) }}
      style={{ width: size, height: size }}
      accessibilityIgnoresInvertColors
    />
  );
}
