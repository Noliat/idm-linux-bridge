#!/usr/bin/env python3
"""
build_crx.py — empacota uma pasta de extensão MV3 em um arquivo .crx3
assinado, compatível com Chrome/Chromium/Edge/Opera.

Implementa o formato CRX3 manualmente (cabeçalho protobuf + assinatura
RSA-SHA256), sem depender de bibliotecas externas além do `openssl` do
sistema (já é dependência do projeto via scripts/install.sh).

Uso:
    build_crx.py <pasta_extensao> <chave_privada.pem> <saida.crx>

Saída (stdout, uma linha): o extension_id de 32 caracteres derivado da
chave pública — o mesmo algoritmo usado pelo Chrome Web Store (SHA-256
da chave pública DER, primeiros 16 bytes, cada nibble mapeado para a-p).

Se a chave privada não existir, é gerada automaticamente (RSA 2048).
Reutilizar a MESMA chave entre builds é o que mantém o extension_id
estável — trocar a chave muda o ID e o Chrome trata como uma extensão
totalmente diferente (perde configurações/permissões do usuário).
"""
import sys
import os
import struct
import hashlib
import zipfile
import subprocess
import tempfile


def varint(n):
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            out += bytes([b])
            break
    return out


def tag(field_num, wire_type):
    return varint((field_num << 3) | wire_type)


def length_delimited(field_num, data):
    return tag(field_num, 2) + varint(len(data)) + data


def ensure_key(key_path):
    """Gera uma chave RSA 2048 em key_path se ainda não existir."""
    if os.path.exists(key_path):
        return
    r = subprocess.run(
        ["openssl", "genrsa", "-out", key_path, "2048"],
        capture_output=True, text=True
    )
    if r.returncode != 0:
        sys.exit(f"ERRO: falha ao gerar chave privada: {r.stderr}")
    os.chmod(key_path, 0o600)


def get_public_key_der(key_path):
    r = subprocess.run(
        ["openssl", "rsa", "-in", key_path, "-pubout", "-outform", "DER"],
        capture_output=True
    )
    if r.returncode != 0:
        sys.exit(f"ERRO: falha ao extrair chave pública: {r.stderr.decode()}")
    return r.stdout


def extension_id_from_pubkey(pubkey_der):
    digest = hashlib.sha256(pubkey_der).digest()[:16]
    return "".join(
        chr(ord('a') + (b >> 4)) + chr(ord('a') + (b & 0xF))
        for b in digest
    )


def build_zip_bytes(src_dir):
    """Compacta a pasta da extensão de forma determinística (ordem
    estável de arquivos), para que builds repetidos do mesmo conteúdo
    produzam o mesmo zip byte-a-byte."""
    fd, tmp_path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(src_dir):
                dirs.sort()
                for fn in sorted(files):
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, src_dir)
                    zf.write(full, rel)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        os.unlink(tmp_path)


def sign(key_path, data):
    fd, tmp_path = tempfile.mkstemp()
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            f.write(data)
        sig_fd, sig_path = tempfile.mkstemp()
        os.close(sig_fd)
        try:
            r = subprocess.run(
                ["openssl", "dgst", "-sha256", "-sign", key_path,
                 "-out", sig_path, tmp_path],
                capture_output=True
            )
            if r.returncode != 0:
                sys.exit(f"ERRO: falha ao assinar: {r.stderr.decode()}")
            with open(sig_path, "rb") as f:
                return f.read()
        finally:
            os.unlink(sig_path)
    finally:
        os.unlink(tmp_path)


def build_crx3(src_dir, key_path, out_path):
    ensure_key(key_path)
    pubkey_der = get_public_key_der(key_path)
    ext_id = extension_id_from_pubkey(pubkey_der)

    zip_bytes = build_zip_bytes(src_dir)

    # crx_id = primeiros 16 bytes do SHA-256 da chave pública DER
    crx_id = hashlib.sha256(pubkey_der).digest()[:16]

    # SignedData { crx_id: bytes = 1 }
    signed_header_data = length_delimited(1, crx_id)

    # Dados assinados: "CRX3 SignedData\0" + len(signed_header_data) LE32
    #                   + signed_header_data + conteúdo do zip
    to_be_signed = (
        b"CRX3 SignedData\x00"
        + struct.pack("<I", len(signed_header_data))
        + signed_header_data
        + zip_bytes
    )
    signature = sign(key_path, to_be_signed)

    # AsymmetricKeyProof { public_key: bytes = 1, signature: bytes = 2 }
    proof = length_delimited(1, pubkey_der) + length_delimited(2, signature)

    # CrxFileHeader { sha256_with_rsa: AsymmetricKeyProof = 2 (repeated),
    #                 signed_header_data: bytes = 10000 }
    header_proto = (
        length_delimited(2, proof)
        + length_delimited(10000, signed_header_data)
    )

    crx = (
        b"Cr24"
        + struct.pack("<I", 3)
        + struct.pack("<I", len(header_proto))
        + header_proto
        + zip_bytes
    )

    with open(out_path, "wb") as f:
        f.write(crx)

    return ext_id


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__)

    src_dir, key_path, out_path = sys.argv[1:4]

    if not os.path.isdir(src_dir):
        sys.exit(f"ERRO: pasta não encontrada: {src_dir}")
    if not os.path.isfile(os.path.join(src_dir, "manifest.json")):
        sys.exit(f"ERRO: manifest.json não encontrado em: {src_dir}")

    ext_id = build_crx3(src_dir, key_path, out_path)
    print(ext_id)


if __name__ == "__main__":
    main()
