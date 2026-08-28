import subprocess
import tempfile
from pathlib import Path
import io
import logging

import pillow_heif
from PIL import Image, ImageOps

pillow_heif.register_heif_opener()

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

# Disk-backed scratch dir (not tmpfs) — keeps intermediate files off RAM
SCRATCH_DIR = Path("/app/scratch")


def convert_to_avif(input_bytes: bytes, file_type: str) -> bytes:
    """
    Converts JPEG or HEIC bytes to AVIF bytes.

    HEIC pipeline: pillow-heif decodes in Python RAM → PNG written to disk-backed
    scratch dir → heif-enc encodes to AVIF → PNG deleted immediately.

    JPEG pipeline: avifenc encodes directly, no intermediate file needed.

    The TemporaryDirectory removes all intermediate files on the way out,
    on success and on failure alike.
    """
    file_type = file_type.lower().strip('.')

    with tempfile.TemporaryDirectory(dir=SCRATCH_DIR) as tmpdir:
        tmp_path = Path(tmpdir)
        in_p = tmp_path / f"input.{file_type}"
        out_p = tmp_path / "output.avif"

        in_p.write_bytes(input_bytes)

        if file_type == "heic":
            _convert_heic_to_avif(in_p, out_p)
        else:
            _convert_jpeg_to_avif(in_p, out_p)

        return out_p.read_bytes()


def _convert_heic_to_avif(in_p: Path, out_p: Path):
    """
    HEIC → PNG (disk) → AVIF

    pillow-heif decodes the HEIC in Python RAM (unavoidable — the pixels have
    to live somewhere). The PNG is written to the disk-backed scratch dir so it
    doesn't count against the container's RAM budget, and is deleted as soon as
    heif-enc is done with it.
    """
    png_p = in_p.parent / "decoded.png"

    try:
        # Decode HEIC → PIL Image in RAM, then flush to disk as PNG
        with Image.open(in_p) as img:
            # Convert to RGB — HEIC can be RGBA or P mode which avifenc may reject
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            img.save(png_p, format="PNG")

        # Encode PNG → AVIF
        # No --speed flag: not supported in Alpine's libheif-tools 1.21.x
        result = subprocess.run(
            ["heif-enc", "--avif", "-q", "60", str(png_p), "-o", str(out_p)],
            capture_output=True,
            text=True,
        )

        if result.returncode != 0:
            raise RuntimeError(f"heif-enc failed: {result.stderr.strip()}")

    finally:
        # Always remove the intermediate PNG from disk
        png_p.unlink(missing_ok=True)


def _convert_jpeg_to_avif(in_p: Path, out_p: Path):
    """JPEG → AVIF directly via avifenc. No intermediate file needed."""
    result = subprocess.run(
        ["avifenc", "--jobs", "1", str(in_p), str(out_p)],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        raise RuntimeError(f"avifenc failed: {result.stderr.strip()}")


def generate_thumbnail_webp(image_bytes: bytes, max_width: int = 400) -> bytes:
    with Image.open(io.BytesIO(image_bytes)) as img:
        img = ImageOps.exif_transpose(img)
        if img.mode not in ('RGB', 'L'):
            img = img.convert('RGB')
        if img.width > max_width:
            ratio = max_width / img.width
            img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format='WEBP', quality=75)
        return buf.getvalue()
