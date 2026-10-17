#!/usr/bin/env python3
"""Regenerate test/fixtures/encrypted/*.pdf: one small page with a foreign
annotation, encrypted by qpdf (via pikepdf) with each Standard security
handler revision pdf2takeoff supports, plus the cases it must refuse.
qpdf is an independent implementation, so these check interop, not just
that our encrypt and decrypt agree with each other.

    uv venv /tmp/venv && VIRTUAL_ENV=/tmp/venv uv pip install pikepdf
    /tmp/venv/bin/python scripts/make-encrypted-fixtures.py
"""

from pathlib import Path

import pikepdf
from pikepdf import Encryption, Permissions

OUT = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "encrypted"


def base() -> pikepdf.Pdf:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(600, 400))
    page = pdf.pages[0]
    page.obj.Contents = pdf.make_stream(b"0 0 1 rg 50 50 100 100 re f")
    note = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Text,
            Rect=[10, 10, 30, 30],
            T=pikepdf.String("Reviewer"),
            Contents=pikepdf.String("see me ü"),
        )
    )
    page.obj.Annots = pdf.make_indirect(pikepdf.Array([note]))
    pdf.docinfo["/Title"] = "Encrypted fixture"
    return pdf


CASES = {
    # name: (Encryption, save kwargs)
    "rc4-40": (Encryption(owner="owner", user="", R=2, aes=False, metadata=False), {}),
    "rc4-128": (Encryption(owner="owner", user="", R=3, aes=False, metadata=False), {}),
    "aes-128": (Encryption(owner="owner", user="", R=4, aes=True), {}),
    "aes-128-objstm": (Encryption(owner="owner", user="", R=4, aes=True), {"object_stream_mode": pikepdf.ObjectStreamMode.generate}),
    "aes-256": (Encryption(owner="owner", user="", R=6), {}),
    "aes-256-objstm": (Encryption(owner="owner", user="", R=6), {"object_stream_mode": pikepdf.ObjectStreamMode.generate}),
    "no-annotate": (Encryption(owner="owner", user="", R=6, allow=Permissions(modify_annotation=False)), {}),
    "open-password": (Encryption(owner="owner", user="secret", R=6), {}),
}


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (enc, kwargs) in CASES.items():
        base().save(OUT / f"{name}.pdf", encryption=enc, **kwargs)
        print(OUT / f"{name}.pdf")


if __name__ == "__main__":
    main()
