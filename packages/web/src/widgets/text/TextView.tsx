/**
 * `TextView.markdown(id, source)` / `TextView.html(id, source)`: the source rendered as sanitized HTML
 * (`sanitize.ts`) in the element's own box, typeset with the app's text styles. A link opens on the device; when the
 * TextView has `on_link_click`, an `http(s)` link is reported to the mod instead (`event {kind:"link", data:{href}}`).
 */

import { type ReactElement, useContext, useMemo } from "react";
import { claim } from "../../render/events.ts";
import { RenderContext } from "../../render/context.ts";
import type { WidgetProps } from "../../render/widgets.tsx";
import { renderMarkdown, sanitizeHtml } from "./sanitize.ts";

const MOD_LINK = /^https?:\/\//i;

export function TextView({ node, dom }: WidgetProps): ReactElement {
  const env = useContext(RenderContext);
  const markdown = node.widget.type === "markdown";
  const source = typeof node.widget.props?.source === "string" ? node.widget.props.source : "";
  const html = useMemo(() => (markdown ? renderMarkdown(source) : sanitizeHtml(source)), [markdown, source]);
  const link = typeof node.on?.link === "number" ? node.on.link : undefined;
  return (
    <div
      {...dom}
      className={`${dom.className} w-text`}
      data-format={node.widget.type}
      onClick={(e) => {
        const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
        const href = a && e.currentTarget.contains(a) ? a.getAttribute("href") ?? "" : "";
        if (link !== undefined && env.send && MOD_LINK.test(href) && claim(e.nativeEvent, "link")) {
          e.preventDefault();
          env.send(link, "link", { href });
        }
        dom.onClick?.(e);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
