#!/usr/bin/env python3
"""Analyse a reference .pptx and synthesise a deck-wide design footprint.

Reads `ppt/theme/theme1.xml` (color scheme + font scheme) and the first
`ppt/slides/slide1.xml` (actual rPr usage) from the pptx zip. Produces:

    <output_dir>/global.css     — slide-canvas CSS using extracted variables
    <output_dir>/design.json    — palette + typography in slides_brief.json
                                  shape, plus the raw theme dump for audit

Usage:
    python extract_pptx_style.py <pptx_path> <output_dir>

The script imitates the pptx's palette / typography so downstream slide
generation can stay faithful to the reference deck. No external deps —
uses zipfile + xml.etree only.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

# Standard PowerPoint preset colors → hex. Used when a clrScheme slot points at
# a named preset rather than an explicit srgbClr.
PRESET_COLORS = {
    "windowText": "#000000", "windowBackground": "#FFFFFF",
    "menuText": "#000000", "menuBar": "#FFFFFF",
}


class ColorParser:
    """Utility class for parsing color information from XML elements."""
    
    @staticmethod
    def hex_from_node(node: ET.Element | None) -> str | None:
        if node is None:
            return None
        srgb = node.find("a:srgbClr", NS)
        if srgb is not None and srgb.get("val"):
            return "#" + srgb.get("val").upper()
        sys_ = node.find("a:sysClr", NS)
        if sys_ is not None:
            # sysClr always carries a lastClr fallback for the rendered hex.
            last = sys_.get("lastClr")
            if last:
                return "#" + last.upper()
            val = sys_.get("val")
            if val and val in PRESET_COLORS:
                return PRESET_COLORS[val]
        preset = node.find("a:prstClr", NS)
        if preset is not None and preset.get("val") in PRESET_COLORS:
            return PRESET_COLORS[preset.get("val")]
        return None


class FontParser:
    """Utility class for parsing font information from XML elements."""
    
    @staticmethod
    def extract_fonts(fonts_node: ET.Element | None) -> dict:
        fonts = {"heading": None, "body": None}
        
        if fonts_node is None:
            return fonts
            
        major = fonts_node.find("a:majorFont/a:latin", NS)
        if major is not None and major.get("typeface"):
            fonts["heading"] = major.get("typeface")
        minor = fonts_node.find("a:minorFont/a:latin", NS)
        if minor is not None and minor.get("typeface"):
            fonts["body"] = minor.get("typeface")
        # East-asian fallback — useful when the deck is Chinese.
        major_ea = fonts_node.find("a:majorFont/a:ea", NS)
        if major_ea is not None and major_ea.get("typeface"):
            fonts["heading_ea"] = major_ea.get("typeface")
        minor_ea = fonts_node.find("a:minorFont/a:ea", NS)
        if minor_ea is not None and minor_ea.get("typeface"):
            fonts["body_ea"] = minor_ea.get("typeface")
            
        return fonts


class CSSGenerator:
    """Handles CSS template generation and variable substitution."""
    
    CSS_TEMPLATE = """\
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Crimson+Text:wght@400;600;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@400;700&display=swap');

:root {{
  --bg: {bg};
  --primary: {primary};
  --accent: {accent};
}}

* {{ box-sizing: border-box; margin: 0; padding: 0; }}

body {{
  font-family: '{body_font}', 'Inter', 'Helvetica Neue', 'Segoe UI', Arial,
               'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background-color: var(--bg);
  color: var(--primary);
}}

.slide {{
  width: 1280px;
  height: 720px;
  background-color: var(--bg);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}}

h1, h2, h3 {{
  font-family: '{heading_font}', 'Inter', 'Helvetica Neue', 'Segoe UI', Arial,
               'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-weight: 700;
  line-height: 1.2;
}}

h1 {{
  font-size: 56px;
  margin-bottom: 24px;
  color: var(--primary);
}}

h2 {{
  font-size: 42px;
  margin-bottom: 16px;
  color: var(--primary);
}}

h3 {{
  font-size: 32px;
  margin-bottom: 12px;
  color: var(--primary);
}}

p {{
  font-size: 20px;
  line-height: 1.5;
  margin-bottom: 16px;
}}

a {{
  color: var(--accent);
  text-decoration: none;
}}

ul, ol {{
  margin-left: 24px;
  margin-bottom: 16px;
}}

li {{
  font-size: 20px;
  line-height: 1.5;
  margin-bottom: 8px;
}}

code {{
  font-family: 'Crimson Text', 'Times New Roman', 'SimSun', serif;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 2px 4px;
  border-radius: 3px;
}}

pre {{
  font-family: 'Crimson Text', 'Times New Roman', 'SimSun', serif;
  background-color: rgba(0, 0, 0, 0.05);
  padding: 16px;
  border-radius: 3px;
  overflow-x: auto;
  margin-bottom: 16px;
}}

blockquote {{
  border-left: 4px solid var(--accent);
  padding-left: 16px;
  margin: 16px 0;
  font-style: italic;
}}

table {{
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
}}

th, td {{
  border: 1px solid rgba(0, 0, 0, 0.1);
  padding: 8px 12px;
  text-align: left;
}}

th {{
  background-color: rgba(0, 0, 0, 0.05);
}}

img {{
  max-width: 100%;
  height: auto;
  margin-bottom: 16px;
}}

.footer {{
  padding: 16px;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.5);
  text-align: center;
}}

.header {{
  padding: 16px;
  font-size: 16px;
  color: rgba(0, 0, 0, 0.7);
  text-align: right;
}}

.slide-content {{
  flex-grow: 1;
  padding: 40px 60px;
  display: flex;
  flex-direction: column;
}}

.slide-number {{
  position: absolute;
  bottom: 16px;
  right: 16px;
  font-size: 14px;
  color: rgba(0, 0, 0, 0.5);
}}
"""

    @classmethod
    def generate_css(cls, design: dict) -> str:
        """Generate CSS from design variables."""
        return cls.CSS_TEMPLATE.format(
            bg=design["background"],
            primary=design["primary"],
            accent=design["accent"],
            heading_font=design["heading_font"],
            body_font=design["body_font"],
        )


class ThemeConfig:
    """Manages theme presets and default values."""
    
    DEFAULT_THEME = {
        "palette": {
            "lt1": "#FFFFFF",
            "lt2": "#F3F4F6",
            "dk1": "#1C1917",
            "dk2": "#343A40",
            "accent1": "#2563EB",
            "accent2": "#7C3AED",
            "accent3": "#DB2777",
            "accent4": "#EA580C",
            "accent5": "#059669",
            "accent6": "#0891B2",
            "hlink": "#2563EB",
            "folHlink": "#7C3AED",
        },
        "fonts": {
            "heading": "Inter",
            "body": "Inter",
            "heading_ea": None,
            "body_ea": None,
        }
    }
    
    @classmethod
    def get_default_theme(cls) -> dict:
        """Return the default theme configuration."""
        return cls.DEFAULT_THEME


def parse_theme(theme_xml: bytes) -> dict:
    root = ET.fromstring(theme_xml)
    out: dict = {"palette": {}, "fonts": {"heading": None, "body": None}}

    clr = root.find(".//a:clrScheme", NS)
    if clr is not None:
        for slot in (
            "dk1", "lt1", "dk2", "lt2",
            "accent1", "accent2", "accent3", "accent4", "accent5", "accent6",
            "hlink", "folHlink",
        ):
            node = clr.find(f"a:{slot}", NS)
            hex_val = ColorParser.hex_from_node(node)
            if hex_val:
                out["palette"][slot] = hex_val

    fonts = root.find(".//a:fontScheme", NS)
    out["fonts"] = FontParser.extract_fonts(fonts)

    return out


def sample_slide_usage(slide_xml: bytes) -> dict:
    """Inspect actual srgbClr fills + rPr typefaces used on slide 1."""
    root = ET.fromstring(slide_xml)
    colors = collections.Counter()
    typefaces = collections.Counter()
    sizes = collections.Counter()
    for srgb in root.iter(f"{{{NS['a']}}}srgbClr"):
        if srgb.get("val"):
            colors["#" + srgb.get("val").upper()] += 1
    for rpr in root.iter(f"{{{NS['a']}}}rPr"):
        sz = rpr.get("sz")
        if sz:
            sizes[int(sz)] += 1
        for tag in ("latin", "ea", "cs"):
            face = rpr.find(f"a:{tag}", NS)
            if face is not None and face.get("typeface"):
                typefaces[face.get("typeface")] += 1
    return {
        "top_colors": colors.most_common(8),
        "top_typefaces": typefaces.most_common(6),
        "top_font_sizes_hpt": sizes.most_common(6),  # OOXML stores sz in hundredths of pt
    }


def synthesize_design(theme: dict, slide: dict | None) -> dict:
    p = theme["palette"]
    bg = p.get("lt1") or p.get("lt2") or ThemeConfig.get_default_theme()["palette"]["lt1"]
    primary = p.get("dk1") or p.get("dk2") or ThemeConfig.get_default_theme()["palette"]["dk1"]
    accent = p.get("accent1") or ThemeConfig.get_default_theme()["palette"]["accent1"]

    # If slide1 uses a markedly more common non-bg, non-primary color, prefer
    # it as the accent — themes sometimes carry a placeholder accent that the
    # actual deck never uses.
    if slide:
        for hex_val, _count in slide["top_colors"]:
            if hex_val.upper() not in {bg.upper(), primary.upper()}:
                accent = hex_val
                break

    heading = theme["fonts"].get("heading") or ThemeConfig.get_default_theme()["fonts"]["heading"]
    body = theme["fonts"].get("body") or ThemeConfig.get_default_theme()["fonts"]["body"]
    return {
        "background": bg,
        "primary": primary,
        "accent": accent,
        "heading_font": heading,
        "body_font": body,
    }


def extract_pptx_styles(pptx_path: str, output_dir: str) -> None:
    """Extract styles from a PowerPoint file and generate CSS and JSON."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    try:
        with zipfile.ZipFile(pptx_path) as zf:
            theme_xml = zf.read("ppt/theme/theme1.xml")
            slide_xml = zf.read("ppt/slides/slide1.xml")
    except (KeyError, zipfile.BadZipFile) as e:
        raise ValueError(f"Invalid PPTX file: {e}") from e

    theme = parse_theme(theme_xml)
    slide = sample_slide_usage(slide_xml)
    design = synthesize_design(theme, slide)

    # Write global.css
    css_content = CSSGenerator.generate_css(design)
    (output_path / "global.css").write_text(css_content)

    # Write design.json
    design_json = {
        "design": design,
        "raw_theme": theme,
        "slide_usage": slide,
    }
    (output_path / "design.json").write_text(json.dumps(design_json, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Extract design elements from a PowerPoint file"
    )
    parser.add_argument("pptx_path", help="Path to the PowerPoint file")
    parser.add_argument("output_dir", help="Directory to output CSS and JSON files")
    args = parser.parse_args()

    try:
        extract_pptx_styles(args.pptx_path, args.output_dir)
        print(f"Successfully extracted styles to {args.output_dir}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()