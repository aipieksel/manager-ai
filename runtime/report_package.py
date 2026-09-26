"""Read-only package verification independent of the workbook authoring engine."""
from pathlib import PurePosixPath
import io
from xml.etree import ElementTree as ET
import zipfile

SHEETS = ['Summary', 'GA4 Detail', 'GA4 Daily', 'GA4 Pages', 'First-Party Detail', 'Methodology']
NS = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def verify_package(data, metrics):
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        members = package.infolist()
        if len(members) > 2000 or sum(m.file_size for m in members) > 100 * 1024 * 1024:
            raise ValueError('workbook_package_limit')
        if len({m.filename for m in members}) != len(members):
            raise ValueError('workbook_package_invalid')
        for member in members:
            name = PurePosixPath(member.filename)
            if name.is_absolute() or '..' in name.parts or member.flag_bits & 1:
                raise ValueError('workbook_package_invalid')
        if package.testzip() is not None:
            raise ValueError('workbook_package_invalid')
        workbook = ET.fromstring(package.read('xl/workbook.xml'))
        sheets = workbook.findall('x:sheets/x:sheet', NS)
        if [s.get('name') for s in sheets] != SHEETS:
            raise ValueError('workbook_sheet_contract_changed')
        rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(package.read('xl/_rels/workbook.xml.rels'))}
        parsed = []
        for sheet in sheets:
            target = rels[sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
            member = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            cells = {c.get('r'): c for c in ET.fromstring(package.read(member)).findall('x:sheetData/x:row/x:c', NS)}
            if any(c.get('t') == 'e' for c in cells.values()):
                raise ValueError('workbook_formula_error')
            parsed.append(cells)
        def number(sheet, address):
            cell = parsed[sheet].get(address)
            value = None if cell is None else cell.find('x:v', NS)
            if value is None or value.text is None:
                raise ValueError('workbook_uncached_total')
            return float(value.text)
        def column_sum(sheet, column):
            return sum(number(sheet, address) for address in parsed[sheet] if address.rstrip('0123456789') == column and address != column+'1')
        actual = [number(0, 'A6'), number(0, 'C6'), number(0, 'F16')]
        expected = [metrics['ga4']['sessions'], metrics['ga4']['engagedSessions'], metrics['firstParty']['visits']]
        detail = [column_sum(1, 'G'), column_sum(1, 'H'), column_sum(4, 'I')]
        if actual != expected or detail != expected:
            raise ValueError('workbook_totals_mismatch')
        return True
