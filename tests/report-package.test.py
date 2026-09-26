import io
import sys
import unittest
import zipfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime'))
from report_package import verify_package, SHEETS


def fixture(error=False, detail=10):
    output = io.BytesIO()
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    with zipfile.ZipFile(output, 'w') as z:
        z.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+''.join(f'<sheet name="{name}" r:id="r{i}"/>' for i,name in enumerate(SHEETS))+'</sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels','<Relationships>'+''.join(f'<Relationship Id="r{i}" Target="worksheets/sheet{i}.xml"/>' for i in range(6))+'</Relationships>')
        cells = [[('A6',10),('C6',6),('F16',12)],[('G2',detail),('H2',6)],[],[],[('I2',12)],[]]
        for i,entries in enumerate(cells):
            z.writestr(f'xl/worksheets/sheet{i}.xml',f'<worksheet xmlns="{ns}"><sheetData><row>'+''.join(f'<c r="{a}"><v>{n}</v></c>' for a,n in entries)+('<c r="Z2" t="e"><v>#REF!</v></c>' if error and i==2 else '')+'</row></sheetData></worksheet>')
    return output.getvalue()


class PackageTests(unittest.TestCase):
    def test_summary_and_detail_both_reconcile(self):
        metrics={'ga4':{'sessions':10,'engagedSessions':6},'firstParty':{'visits':12}}
        self.assertTrue(verify_package(fixture(),metrics))
        with self.assertRaisesRegex(ValueError,'totals_mismatch'):verify_package(fixture(detail=11),metrics)
        with self.assertRaisesRegex(ValueError,'formula_error'):verify_package(fixture(error=True),metrics)

if __name__ == '__main__':unittest.main()
