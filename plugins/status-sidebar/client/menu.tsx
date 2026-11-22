// Paseo's menu (components/ui/menu): an anchored popover whose sub-pages fly out on hover, or a
// bottom sheet that pushes them on touch layouts.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import { Icon, Modal as Sheet, TextInput } from "@getpaseo/plugin/client/ui";
import { UiContext, useUi } from "./styles";

/** react-native-web adds `hovered`; native leaves it undefined. */
export type PressState = PressableStateCallbackType & { hovered?: boolean };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MenuPage {
  title: string;
  content: ReactNode;
  /** Stays put above the scrolling content, like a search field. */
  header?: ReactNode;
  /** A fixed height for the scrolling content, so a filtered list doesn't make the page jump. */
  listHeight?: number;
}

/** Tallest a flyout gets before its content scrolls. */
const FLYOUT_MAX_HEIGHT = 420;

interface MenuApi {
  close(): void;
  page: string | null;
  openPage(id: string, anchor: RefObject<View | null>): void;
  hoverPage(id: string, anchor: RefObject<View | null>): void;
  keepPage(): void;
  leavePage(): void;
}

const MenuContext = createContext<MenuApi | null>(null);

function useMenu(): MenuApi {
  const menu = useContext(MenuContext);
  if (!menu) throw new Error("Menu items render inside <Menu>");
  return menu;
}

function measure(anchor: RefObject<View | null>, done: (rect: Rect) => void) {
  anchor.current?.measureInWindow((x, y, width, height) => done({ x, y, width, height }));
}

/** Hover delays from menu-surface.tsx. */
const HOVER_OPEN_MS = 90;
const HOVER_CLOSE_MS = 260;

interface Size {
  width: number;
  height: number;
}

/**
 * ui/anchor.ts computePosition: the root opens 4pt below its trigger, right edges aligned, and
 * flips above only when there is more room there; a flyout overlaps its row's right edge by 5pt.
 * Either way it stays 8pt inside the window.
 */
function place(
  anchor: Rect,
  size: Size,
  side: "bottom" | "right",
  window: Size,
): { left: number; top: number } {
  let x = anchor.x + anchor.width - 5;
  let y = anchor.y;
  if (side === "bottom") {
    const below = window.height - anchor.y - anchor.height;
    x = anchor.x + anchor.width - size.width;
    y = below < size.height && anchor.y > below ? anchor.y - size.height - 4 : anchor.y + anchor.height + 4;
  }
  return {
    left: Math.max(8, Math.min(window.width - size.width - 8, x)),
    top: Math.max(8, Math.min(window.height - size.height - 8, y)),
  };
}

export function Menu({
  anchor,
  open,
  onClose,
  width,
  title,
  pages = {},
  children,
}: {
  anchor: RefObject<View | null>;
  open: boolean;
  onClose(): void;
  width: number;
  /** The sheet's heading on touch layouts. */
  title: string;
  pages?: Record<string, MenuPage>;
  children: ReactNode;
}) {
  const ui = useUi();
  const { s, c, touch } = ui;
  const window = useWindowDimensions();
  const [rect, setRect] = useState<Rect | null>(null);
  const [page, setPage] = useState<{ id: string; rect: Rect | null } | null>(null);
  // Content sizes inside the border, which is what Paseo positions by.
  const [rootSize, setRootSize] = useState<Size | null>(null);
  const [flyoutSize, setFlyoutSize] = useState<Size>({ width: 178, height: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current !== null) clearTimeout(timer.current);
  };

  useEffect(() => {
    setPage(null);
    setRootSize(null);
    if (open) measure(anchor, setRect);
    return stop;
  }, [open, anchor]);

  const api: MenuApi = {
    close: onClose,
    page: page?.id ?? null,
    openPage(id, row) {
      stop();
      if (touch) setPage({ id, rect: null });
      else measure(row, (rowRect) => setPage({ id, rect: rowRect }));
    },
    hoverPage(id, row) {
      stop();
      timer.current = setTimeout(() => api.openPage(id, row), HOVER_OPEN_MS);
    },
    keepPage: stop,
    leavePage() {
      stop();
      timer.current = setTimeout(() => setPage(null), HOVER_CLOSE_MS);
    },
  };
  const current = page ? pages[page.id] : undefined;

  if (touch) {
    // Paseo's own sheet: a plain React Native Modal opened from inside the phone sidebar could not
    // be dismissed on iOS. The sheet renders in its own tree, so the styles are handed in again.
    return (
      <Sheet title={current?.title ?? title} open={open} onOpenChange={(next) => !next && onClose()}>
        <Sheet.Content scrollable={false} contentContainerStyle={s.sheetBody}>
          <UiContext.Provider value={ui}>
            <MenuContext.Provider value={api}>
              {current ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Back to ${title}`}
                  onPress={() => setPage(null)}
                  style={(state: PressState) => [s.menuItem, (state.hovered || state.pressed) && s.pressed]}
                >
                  <View style={s.menuLeading}>
                    <Icon name="ChevronLeft" size={16} color={c.foregroundMuted} />
                  </View>
                  <Text style={s.menuValue}>{title}</Text>
                </Pressable>
              ) : null}
              {current?.header}
              <ScrollView style={{ maxHeight: window.height * 0.6 }}>
                <View style={s.menuPage}>{current?.content ?? children}</View>
              </ScrollView>
            </MenuContext.Provider>
          </UiContext.Provider>
        </Sheet.Content>
      </Sheet>
    );
  }

  const root = rect && place(rect, rootSize ?? { width: width - 2, height: 0 }, "bottom", window);
  const flyout = page?.rect && place(page.rect, flyoutSize, "right", window);

  return (
    <Modal transparent visible={open} onRequestClose={onClose}>
      <MenuContext.Provider value={api}>
        <Pressable accessibilityLabel="Close menu" style={s.backdrop} onPress={onClose} />
        {root ? (
          <View accessibilityRole="menu" style={[s.menuSurface, root, { width, opacity: rootSize ? 1 : 0 }]}>
            <View style={s.menuPage} onLayout={(event) => setRootSize(event.nativeEvent.layout)}>
              {children}
            </View>
          </View>
        ) : null}
        {current && flyout ? (
          <View
            accessibilityRole="menu"
            style={[
              s.menuSurface,
              flyout,
              { minWidth: 180, maxHeight: Math.min(FLYOUT_MAX_HEIGHT, window.height - 16) },
            ]}
            onPointerEnter={api.keepPage}
            onPointerLeave={api.leavePage}
            onLayout={(event) => setFlyoutSize(event.nativeEvent.layout)}
          >
            {current.header}
            <ScrollView
              style={[s.menuScroll, current.listHeight !== undefined && { height: current.listHeight }]}
              contentContainerStyle={s.menuPage}
            >
              {current.content}
            </ScrollView>
          </View>
        ) : null}
      </MenuContext.Provider>
    </Modal>
  );
}

export function MenuItem({
  label,
  icon,
  leading,
  selected,
  trailing,
  active = false,
  disabled = false,
  closeOnSelect = true,
  onSelect,
}: {
  label: string;
  /** A Lucide export name for the leading slot. */
  icon?: string;
  leading?: ReactElement;
  /** Draws the check. */
  selected?: boolean;
  trailing?: ReactElement;
  /** Its sub-page is open. */
  active?: boolean;
  disabled?: boolean;
  closeOnSelect?: boolean;
  onSelect?(): void;
}) {
  const { s, c } = useUi();
  const menu = useMenu();
  const mark = icon ? <Icon name={icon} size={14} color={c.foregroundMuted} /> : leading;
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityState={selected === undefined ? { disabled } : { checked: selected, disabled }}
      disabled={disabled}
      onPress={() => {
        if (closeOnSelect) menu.close();
        onSelect?.();
      }}
      style={(state: PressState) => [
        s.menuItem,
        (active || state.hovered || state.pressed) && !disabled && s.pressed,
        disabled && { opacity: 0.5 },
      ]}
    >
      {mark ? <View style={s.menuLeading}>{mark}</View> : null}
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={s.menuItemText}>
          {label}
        </Text>
      </View>
      {trailing ??
        (selected ? (
          <View style={s.menuTrailing}>
            <Icon name="Check" size={16} color={c.foregroundMuted} />
          </View>
        ) : null)}
    </Pressable>
  );
}

/** A row leading to a sub-page, with the decision's current value ("Grouping  Project ›"). */
export function MenuSubTrigger({
  id,
  label,
  value,
  indicator = false,
  icon,
}: {
  id: string;
  label: string;
  value?: string;
  /** A non-default setting inside, such as an active filter. */
  indicator?: boolean;
  icon?: string;
}) {
  const { s, c, touch } = useUi();
  const menu = useMenu();
  const anchor = useRef<View>(null);
  return (
    <View
      ref={anchor}
      collapsable={false}
      onPointerEnter={touch ? undefined : () => menu.hoverPage(id, anchor)}
      onPointerLeave={touch ? undefined : menu.leavePage}
    >
      <MenuItem
        label={label}
        icon={icon}
        active={menu.page === id}
        closeOnSelect={false}
        onSelect={() => menu.openPage(id, anchor)}
        trailing={
          <View style={s.menuTrailing}>
            {value ? (
              <Text numberOfLines={1} style={s.menuValue}>
                {value}
              </Text>
            ) : null}
            {indicator ? <View style={s.menuIndicator} /> : null}
            <Icon name="ChevronRight" size={14} color={c.foregroundMuted} />
          </View>
        }
      />
    </View>
  );
}

export function MenuSeparator() {
  return <View style={useUi().s.menuSeparator} />;
}

/** A menu page's search field (the combobox search in Paseo's menus). */
export function MenuSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange(value: string): void;
  placeholder: string;
}) {
  const { s, c } = useUi();
  return (
    <View style={s.menuSearch}>
      <Icon name="Search" size={14} color={c.foregroundMuted} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={c.foregroundMuted}
        accessibilityLabel={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={s.menuSearchInput}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          hitSlop={6}
          onPress={() => onChange("")}
        >
          <Icon name="X" size={13} color={c.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}
