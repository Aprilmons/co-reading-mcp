import base64
import io
import struct
import sys
import unittest
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from PIL import Image
from book_cover import CoverError, extract_cover, normalize_image, validate_zip


def picture():
    data = io.BytesIO()
    Image.new('RGB', (900, 1400), '#689088').save(data, 'PNG')
    return data.getvalue()


def epub(kind='epub3', extra=None):
    out = io.BytesIO()
    metadata = '<meta name="cover" content="art"/>' if kind == 'epub2' else ''
    props = ' properties="cover-image"' if kind == 'epub3' else ''
    guide = '<guide><reference type="cover" href="cover.xhtml"/></guide>' if kind.startswith('guide') else ''
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>')
        z.writestr('OEBPS/book.opf', f'<package><metadata>{metadata}</metadata><manifest><item id="art" href="images/art.png" media-type="image/png"{props}/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine>{guide}</package>')
        z.writestr('OEBPS/images/art.png', picture())
        doctype = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">' if kind == 'guide-doctype' else ''
        z.writestr('OEBPS/cover.xhtml', doctype + '<html><body><img src="images/art.png"/></body></html>')
        z.writestr('OEBPS/chapter.xhtml', '<html><body><h1>Chapter</h1><p>A synthetic readable chapter with enough words.</p></body></html>')
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    out.seek(0)
    return out


class Covers(unittest.TestCase):
    def test_epub2_epub3_guide_extract_same_cover(self):
        covers = [extract_cover(epub(kind)) for kind in ('epub2', 'epub3', 'guide', 'guide-doctype')]
        self.assertTrue(covers[0])
        self.assertEqual(covers[0], covers[1])
        self.assertEqual(covers[1], covers[2])
        self.assertEqual(covers[2], covers[3])
        self.assertEqual(covers[0]['height'], 640)

    def test_absent_cover_does_not_pick_random_illustration(self):
        self.assertIsNone(extract_cover(epub('absent')))

    def test_reencoding_discards_exif_and_respects_bounds(self):
        source = io.BytesIO()
        exif = Image.Exif()
        exif[270] = 'SYNTHETIC_PRIVATE_METADATA'
        Image.new('RGB', (100, 150)).save(source, 'JPEG', exif=exif)
        cover = normalize_image(source.getvalue(), 'image/jpeg')
        normalized = base64.b64decode(cover['dataBase64'])
        self.assertNotIn(b'SYNTHETIC_PRIVATE_METADATA', normalized)
        self.assertLessEqual(len(normalized), 524288)
        self.assertEqual(Image.open(io.BytesIO(normalized)).size, (100, 150))

    def test_svg_and_mime_mismatch_fail(self):
        for raw, mime in [(b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', None), (picture(), 'image/jpeg')]:
            with self.assertRaises(CoverError): normalize_image(raw, mime)

    def test_declared_huge_pixels_fail_without_allocating_image(self):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        raw = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 50000, 50000, 8, 2, 0, 0, 0)) + chunk(b'IDAT', b'') + chunk(b'IEND', b'')
        with self.assertRaises(CoverError): normalize_image(raw)

    def test_zip_paths_and_expansion_fail(self):
        with self.assertRaises(CoverError): extract_cover(epub(extra={'../outside.png': picture()}))
        with self.assertRaises(CoverError): extract_cover(epub(extra={'/absolute.png': picture()}))
        info = zipfile.ZipInfo('oversized')
        info.file_size = 65 * 1024 * 1024
        class FakeZip:
            def infolist(self): return [info]
        with self.assertRaises(CoverError): validate_zip(FakeZip())

    def test_xml_entities_fail(self):
        for encoding in ('utf-8', 'utf-16'):
            source = io.BytesIO()
            with zipfile.ZipFile(source, 'w') as z:
                z.writestr('META-INF/container.xml', ('<?xml version="1.0" encoding="' + encoding + '"?><!DOCTYPE root [<!ENTITY x "expanded">]><container>&x;</container>').encode(encoding))
            source.seek(0)
            with self.assertRaises(CoverError): extract_cover(source)


if __name__ == '__main__':
    unittest.main()
