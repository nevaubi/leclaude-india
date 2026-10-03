import {describe,it,expect} from 'vitest';
import {sciLibraryItems,libraryPublicationMeta} from '@/modules/official/adapters/reference/sci-library';
import {normalizeSearch} from '@/modules/official/search';
const pdf='https://cdn.s3waas.gov.in/s3ec0490f1f4972d133619a60c30f3559e/uploads/2025/12/2025121262.pdf';
describe('Supreme Court practice reference source',()=>{
 it('discovers the actual publisher handbook but no Gazette or unrelated PDF',()=>{const items=sciLibraryItems('<a href="'+pdf+'">Practice and Procedure</a><a href="https://evil.example/book.pdf">Practice and Procedure</a><a href="https://www.sci.gov.in/gazette.pdf">Gazette Notification</a>');expect(items).toHaveLength(1);expect(items[0]).toMatchObject({sourceId:'sci-library',kind:'reference_report',fileUrl:pdf,docDate:null});expect(items[0].meta).toMatchObject({authorityType:'practice_handbook',legalVerification:'not_assessed'});});
 it('separates the stated edition date from a publication or effective date',()=>{expect(libraryPublicationMeta('SUPREME COURT OF INDIA HANDBOOK 2017 Updated as on 06.10.2025')).toMatchObject({editionAsOf:'2025-10-06',editionLabel:'Updated as on 06.10.2025',effectiveDate:null});expect(libraryPublicationMeta('No printed edition date')).toMatchObject({editionAsOf:null});});
 it('makes reference publications searchable without pretending they are judgments',()=>{expect(normalizeSearch({q:'filing',sources:['sci-library'],kinds:['reference_report']})).toMatchObject({sources:['sci-library'],kinds:['reference_report']});});
});
