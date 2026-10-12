#!/usr/bin/env python3
"""Extract only an EPUB cover and normalize raster images; never extract ZIP paths."""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import posixpath
import stat
import sys
import warnings
import xml.etree.ElementTree as ET
import xml.parsers.expat as expat
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_COVER_BYTES = 512 * 1024
MAX_PIXELS = 24_000_000
MAX_EDGE = 640


class CoverError(ValueError):
    pass


def _local(tag):
    return tag.split('}', 1)[-1].lower()


def _path(base, href):
    value = unquote(href.split('#', 1)[0])
    if not value or '\\' in value or '\x00' in value or urlsplit(value).scheme or value.startswith('/'):
        raise CoverError('Unsafe EPUB resource path')
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(base), value))
    if resolved == '..' or resolved.startswith('../'):
        raise CoverError('Unsafe EPUB resource path')
    return resolved


def validate_zip(zf):
    infos = zf.infolist()
    if len(infos) > 5000 or sum(i.file_size for i in infos) > 200 * 1024 * 1024:
        raise CoverError('EPUB exceeds safe expansion limits')
    seen = set()
    for info in infos:
        name = info.filename
        if name in seen or name.startswith('/') or '\\' in name or '\x00' in name or '..' in name.split('/'):
            raise CoverError('Unsafe or duplicate EPUB member')
        seen.add(name)
        if info.flag_bits & 1 or stat.S_ISLNK(info.external_attr >> 16):
            raise CoverError('Encrypted or linked EPUB members are unsupported')
        if info.file_size > 64 * 1024 * 1024:
            raise CoverError('EPUB member exceeds safe expansion limits')


def _read(zf, name, limit):
    info = zf.getinfo(name)
    if info.file_size > limit:
        raise CoverError('EPUB resource is too large')
    with zf.open(info) as source:
        result = source.read(limit + 1)
    if len(result) > limit:
        raise CoverError('EPUB resource is too large')
    return result


def _xml(raw):
    # Expat decodes XML encodings (including UTF-16) before these callbacks.
    # Normal XHTML DOCTYPEs are common; external DTDs are never loaded.
    parser = expat.ParserCreate()
    def forbid(*_):
        raise CoverError('EPUB entity declarations are unsupported')
    def doctype(_name, _system, _public, internal):
        if internal:
            forbid()
    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = forbid
    parser.ExternalEntityRefHandler = forbid
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    try:
        parser.Parse(raw, True)
    except expat.ExpatError as error:
        raise ET.ParseError(str(error)) from error
    return ET.fromstring(raw)


def epub_cover_bytes(source):
    """EPUB3 cover-image, EPUB2 cover id, then explicit cover page references."""
    with zipfile.ZipFile(source) as zf:
        validate_zip(zf)
        container = _xml(_read(zf, 'META-INF/container.xml', 1024 * 1024))
        opf = next((e.attrib.get('full-path') for e in container.iter() if _local(e.tag) == 'rootfile'), None)
        if not opf:
            return None
        opf = _path('', opf)
        root = _xml(_read(zf, opf, 1024 * 1024))
        items = {e.attrib.get('id'): e for e in root.iter() if _local(e.tag) == 'item' and e.attrib.get('href')}
        candidates = []
        for item in items.values():
            if 'cover-image' in item.attrib.get('properties', '').split():
                candidates.append(_path(opf, item.attrib['href']))
        for element in root.iter():
            if _local(element.tag) == 'meta' and element.attrib.get('name', '').lower() == 'cover':
                item = items.get(element.attrib.get('content'))
                if item is not None:
                    candidates.append(_path(opf, item.attrib['href']))
        for element in root.iter():
            if _local(element.tag) == 'reference' and element.attrib.get('type', '').lower() == 'cover' and element.attrib.get('href'):
                candidates.append(_path(opf, element.attrib['href']))
        # Some older EPUBs omit metadata, but explicitly name the cover resource.
        for item_id, item in items.items():
            href = item.attrib['href']
            stem = posixpath.basename(href).rsplit('.', 1)[0].lower()
            if str(item_id).lower() in {'cover', 'cover-image', 'coverimage'} or stem in {'cover', 'cover-image', 'coverimage'}:
                candidates.append(_path(opf, href))
        visited = set()
        for candidate in candidates:
            if candidate in visited:
                continue
            visited.add(candidate)
            if candidate.lower().endswith(('.html', '.xhtml', '.htm', '.svg')):
                try:
                    page = _xml(_read(zf, candidate, 1024 * 1024))
                    refs = []
                    for element in page.iter():
                        if _local(element.tag) in {'img', 'image'}:
                            href = element.attrib.get('src') or element.attrib.get('href') or element.attrib.get('{http://www.w3.org/1999/xlink}href')
                            if href:
                                refs.append(_path(candidate, href))
                    candidates.extend(refs)
                except (KeyError, ET.ParseError):
                    continue
            else:
                try:
                    data = _read(zf, candidate, MAX_IMAGE_BYTES)
                    # Decode before accepting a candidate; never return arbitrary book files.
                    normalize_image(data)
                    return data
                except (KeyError, CoverError):
                    continue
        return None


def normalize_image(data, expected_mime=None):
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise CoverError('Cover image is empty or too large')
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    allowed = {'JPEG': 'image/jpeg', 'PNG': 'image/png', 'WEBP': 'image/webp'}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as original:
                mime = allowed.get(original.format)
                if not mime or (expected_mime and mime != expected_mime):
                    raise CoverError('A JPEG, PNG or WebP matching its declared type is required')
                if original.width < 1 or original.height < 1 or original.width * original.height > MAX_PIXELS or max(original.size) > 20000:
                    raise CoverError('Cover dimensions exceed safe limits')
                original.seek(0)
                original.load()
                image = ImageOps.exif_transpose(original)
                image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)
                # A fresh RGB canvas strips EXIF, ICC, comments, alpha and executable metadata.
                clean = Image.new('RGB', image.size, 'white')
                if 'A' in image.getbands() or 'transparency' in image.info:
                    rgba = image.convert('RGBA')
                    clean.paste(rgba, mask=rgba.getchannel('A'))
                else:
                    clean.paste(image.convert('RGB'))
                output = io.BytesIO()
                clean.save(output, format='JPEG', quality=86, optimize=True)
                normalized = output.getvalue()
                if len(normalized) > MAX_COVER_BYTES:
                    raise CoverError('Normalized cover is too large')
                return {'mimeType': 'image/jpeg', 'width': clean.width, 'height': clean.height,
                        'sha256': hashlib.sha256(normalized).hexdigest(),
                        'dataBase64': base64.b64encode(normalized).decode('ascii')}
    except (UnidentifiedImageError, OSError, Image.DecompressionBombWarning, Image.DecompressionBombError, ValueError) as error:
        raise CoverError('Invalid or unsafe cover image') from error


def extract_cover(source):
    data = epub_cover_bytes(source)
    return normalize_image(data) if data else None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--epub', action='store_true')
    parser.add_argument('--mime-type')
    args = parser.parse_args()
    try:
        result = extract_cover(args.input) if args.epub else normalize_image(args.input.read_bytes(), args.mime_type)
        print(json.dumps({'cover': result}, separators=(',', ':')))
    except (CoverError, zipfile.BadZipFile, KeyError, ET.ParseError, OSError):
        print(json.dumps({'error': 'invalid_cover'}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
