/**
 * The playground's sample job: a two-page template (certificate + progress report) and a handful
 * of rows chosen to exercise every part of the engine. The artwork these placeholders sit on is
 * drawn by `scripts/make-sample-assets.mjs`; keep the coordinates of the two files in step.
 */
import {
  TEMPLATE_SCHEMA_VERSION,
  type DataRow,
  type Placeholder,
  type TemplateDefinition,
  type TextPlaceholder,
} from '@/lib/template';

export const SAMPLE_TEMPLATE_URL = '/samples/template.pdf';

/** Font files to load, keyed by `TemplateFont.id`. */
export const SAMPLE_FONT_URLS: Record<string, string> = {
  devanagari: '/samples/fonts/NotoSansDevanagari-Regular.ttf',
};

const NAVY = '#1A2B6D';
const INK = '#26262E';
const MUTED = '#6E6E7A';

type TextOptions = Pick<TextPlaceholder, 'id' | 'label' | 'pageIndex' | 'box' | 'binding'> &
  Partial<Pick<TextPlaceholder, 'fallbackText' | 'required'>> & {
    style?: Partial<TextPlaceholder['style']>;
    fit?: Partial<TextPlaceholder['fit']>;
  };

function text(options: TextOptions): TextPlaceholder {
  const { style, fit, ...rest } = options;
  return {
    type: 'text',
    ...rest,
    style: {
      fontId: 'sans',
      fontSize: 12,
      color: INK,
      align: 'left',
      verticalAlign: 'middle',
      lineHeight: 1.2,
      ...style,
    },
    fit: { wrap: false, shrinkToFit: true, minFontSize: 7, overflow: 'ellipsis', ...fit },
  };
}

const SUBJECTS = ['English', 'Hindi', 'Mathematics', 'Science', 'Social Science'] as const;
const TABLE = { marksColumnX: 425, top: 230, rowHeight: 34, columnWidth: 100 };

const CERTIFICATE: Placeholder[] = [
  {
    id: 'logo',
    type: 'image',
    label: 'School logo',
    pageIndex: 0,
    box: { x: 60, y: 52, width: 64, height: 64 },
    binding: { kind: 'static', value: '/samples/photos/logo.png' },
    fit: 'contain',
  },
  {
    id: 'photo',
    type: 'image',
    label: 'Photo on the certificate',
    pageIndex: 0,
    box: { x: 70, y: 180, width: 110, height: 140 },
    binding: { kind: 'column', column: 'Photo' },
    fit: 'cover',
    // Keep the top of the picture: faces sit in the upper part of a portrait.
    position: { x: 0.5, y: 0.25 },
  },
  text({
    id: 'name',
    label: 'Name',
    pageIndex: 0,
    box: { x: 221, y: 204, width: 400, height: 54 },
    binding: { kind: 'column', column: 'Name' },
    required: true,
    style: {
      fontId: 'serifBold',
      fontSize: 34,
      color: NAVY,
      align: 'center',
      verticalAlign: 'bottom',
    },
    fit: { minFontSize: 12 },
  }),
  text({
    id: 'name-hindi',
    label: 'Name in Hindi',
    pageIndex: 0,
    box: { x: 221, y: 268, width: 400, height: 30 },
    binding: { kind: 'column', column: 'Name (Hindi)' },
    style: { fontId: 'devanagari', fontSize: 18, color: MUTED, align: 'center' },
  }),
  text({
    id: 'class-line',
    label: 'Class and roll number',
    pageIndex: 0,
    box: { x: 221, y: 304, width: 400, height: 24 },
    binding: { kind: 'template', template: 'Class {{Class}}  ·  Roll No. {{Roll}}' },
    style: { fontSize: 13, align: 'center' },
  }),
  text({
    id: 'date',
    label: 'Date',
    pageIndex: 0,
    box: { x: 221, y: 384, width: 400, height: 22 },
    binding: { kind: 'template', template: 'Awarded on {{Date}}' },
    style: { fontSize: 11, color: MUTED, align: 'center' },
  }),
  {
    id: 'qr',
    type: 'qr',
    label: 'Verification code',
    pageIndex: 0,
    box: { x: 690, y: 432, width: 90, height: 90 },
    binding: { kind: 'template', template: 'https://verify.example.in/c/{{ID}}' },
    errorCorrection: 'M',
    foreground: NAVY,
    quietZone: 2,
  },
];

const REPORT: Placeholder[] = [
  text({
    id: 'report-name',
    label: 'Name',
    pageIndex: 1,
    box: { x: 70, y: 116, width: 350, height: 24 },
    binding: { kind: 'column', column: 'Name' },
    style: { fontId: 'sansBold', fontSize: 16 },
  }),
  text({
    id: 'report-class',
    label: 'Class',
    pageIndex: 1,
    box: { x: 70, y: 156, width: 160, height: 22 },
    binding: { kind: 'column', column: 'Class' },
    style: { fontSize: 13 },
  }),
  text({
    id: 'report-roll',
    label: 'Roll number',
    pageIndex: 1,
    box: { x: 250, y: 156, width: 160, height: 22 },
    binding: { kind: 'column', column: 'Roll' },
    style: { fontSize: 13 },
  }),
  {
    id: 'report-photo',
    type: 'image',
    label: 'Photo on the report',
    pageIndex: 1,
    box: { x: 445, y: 95, width: 80, height: 100 },
    binding: { kind: 'column', column: 'Photo' },
    fit: 'cover',
    position: { x: 0.5, y: 0.25 },
    shape: { kind: 'rounded', radius: 6 },
  },
  ...SUBJECTS.map((subject, index) =>
    text({
      id: `marks-${subject.toLowerCase().replace(/\s+/g, '-')}`,
      label: `${subject} marks`,
      pageIndex: 1,
      box: {
        x: TABLE.marksColumnX,
        y: TABLE.top + (index + 1) * TABLE.rowHeight,
        width: TABLE.columnWidth,
        height: TABLE.rowHeight,
      },
      binding: { kind: 'column', column: subject },
      // "AB" (absent) when the cell is empty.
      fallbackText: 'AB',
      style: { align: 'center' },
    }),
  ),
  text({
    id: 'marks-total',
    label: 'Total marks',
    pageIndex: 1,
    box: {
      x: TABLE.marksColumnX,
      y: TABLE.top + (SUBJECTS.length + 1) * TABLE.rowHeight,
      width: TABLE.columnWidth,
      height: TABLE.rowHeight,
    },
    binding: { kind: 'column', column: 'Total' },
    style: { fontId: 'sansBold', align: 'center' },
  }),
  text({
    id: 'remarks',
    label: 'Remarks',
    pageIndex: 1,
    box: { x: 82, y: 510, width: 431, height: 90 },
    binding: { kind: 'column', column: 'Remarks' },
    style: { fontId: 'devanagari', fontSize: 13, verticalAlign: 'top', lineHeight: 1.4 },
    fit: { wrap: true, minFontSize: 8 },
  }),
];

export const SAMPLE_TEMPLATE: TemplateDefinition = {
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  kind: 'report',
  source: {
    storagePath: 'samples/template.pdf',
    fileName: 'template.pdf',
    byteSize: 0,
    sha256: '',
  },
  pages: [
    { width: 842, height: 595 },
    { width: 595, height: 842 },
  ],
  fonts: [
    { id: 'sans', label: 'Helvetica', source: { kind: 'standard', name: 'Helvetica' } },
    {
      id: 'sansBold',
      label: 'Helvetica Bold',
      source: { kind: 'standard', name: 'Helvetica-Bold' },
    },
    { id: 'serifBold', label: 'Times Bold', source: { kind: 'standard', name: 'Times-Bold' } },
    {
      id: 'devanagari',
      label: 'Noto Sans Devanagari',
      source: { kind: 'library', key: 'noto-sans-devanagari/400' },
    },
  ],
  placeholders: [...CERTIFICATE, ...REPORT],
  output: { fileNameTemplate: '{{Roll}} - {{Name}}' },
};

/** A publicly hosted photo: it has to come through `/api/proxy-image`. */
const EXTERNAL_PHOTO = 'https://www.gstatic.com/webp/gallery/1.jpg';

export const SAMPLE_ROWS: DataRow[] = [
  {
    Name: 'Aarav Sharma',
    'Name (Hindi)': 'आरव शर्मा',
    Class: '10-A',
    Roll: '101',
    Date: '15 March 2026',
    ID: 'CERT-2026-0101',
    // A large photo: shrunk in the browser before it is embedded.
    Photo: '/samples/photos/student-1.jpg',
    English: 88,
    Hindi: 92,
    Mathematics: 95,
    Science: 90,
    'Social Science': 85,
    Total: 450,
    Remarks: 'Aarav is attentive and consistent. उत्कृष्ट प्रदर्शन — इसी तरह आगे बढ़ते रहो।',
  },
  {
    Name: 'Priyanka Tripathi',
    'Name (Hindi)': 'प्रियंका त्रिपाठी',
    Class: '10-A',
    Roll: '102',
    Date: '15 March 2026',
    ID: 'CERT-2026-0102',
    // Stored sideways with an EXIF tag, like a phone photo.
    Photo: '/samples/photos/student-2.jpg',
    English: 94,
    Hindi: 96,
    Mathematics: 89,
    Science: 93,
    'Social Science': 91,
    Total: 463,
    Remarks:
      'प्रियंका कक्षा की सबसे मेहनती छात्राओं में से एक है। विज्ञान और हिन्दी में विशेष रुचि।',
  },
  {
    Name: 'Venkata Subramanian Ramachandran Iyengar',
    'Name (Hindi)': 'वेंकट सुब्रमण्यन रामचंद्रन अयंगर',
    Class: '10-B',
    Roll: '117',
    Date: '15 March 2026',
    ID: 'CERT-2026-0117',
    // WebP: converted in the browser because PDF cannot hold it.
    Photo: '/samples/photos/student-3.webp',
    English: 79,
    Hindi: 71,
    Mathematics: 98,
    Science: 96,
    'Social Science': 82,
    Total: 426,
    Remarks:
      'Venkata has an exceptional aptitude for mathematics and represented the school at the state olympiad. He should read more widely to strengthen his language papers, and take part in class discussions with the same confidence he shows at the blackboard.',
  },
  {
    Name: 'Fatima Sheikh',
    'Name (Hindi)': 'फ़ातिमा शेख़',
    Class: '10-B',
    Roll: '121',
    Date: '15 March 2026',
    ID: 'CERT-2026-0121',
    Photo: EXTERNAL_PHOTO,
    English: 91,
    Hindi: 84,
    Mathematics: 86,
    Science: 88,
    'Social Science': 95,
    Total: 444,
    Remarks: 'A thoughtful student and a natural leader in group work.',
  },
  {
    Name: 'Rahul Verma',
    'Name (Hindi)': 'राहुल वर्मा',
    Class: '10-C',
    Roll: '134',
    Date: '15 March 2026',
    ID: 'CERT-2026-0134',
    // No photo, and absent for one paper.
    Photo: '',
    English: 72,
    Hindi: '',
    Mathematics: 68,
    Science: 74,
    'Social Science': 70,
    Total: 284,
    Remarks: 'Rahul missed the Hindi paper on medical grounds. नियमित अभ्यास की आवश्यकता है।',
  },
  {
    Name: 'Meera Nair',
    'Name (Hindi)': 'मीरा नायर',
    Class: '10-C',
    Roll: '140',
    Date: '15 March 2026',
    ID: 'CERT-2026-0140',
    // A dead link: the document is still produced and the row is reported with a warning.
    Photo: 'https://photos.example.invalid/meera.jpg',
    English: 97,
    Hindi: 90,
    Mathematics: 93,
    Science: 95,
    'Social Science': 92,
    Total: 467,
    Remarks: 'Outstanding in every subject; a pleasure to teach.',
  },
];
