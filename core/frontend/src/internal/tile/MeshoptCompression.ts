/*---------------------------------------------------------------------------------------------
* Copyright (c) Bentley Systems, Incorporated. All rights reserved.
* See LICENSE.md in the project root for license terms and full copyright notice.
*--------------------------------------------------------------------------------------------*/
/** @packageDocumentation
 * @module Tiles
 */

import { Logger } from "@itwin/core-bentley";
import type { ExtMeshoptCompressionFilter, ExtMeshoptCompressionMode } from "../../common/gltf/GltfSchema";
import { FrontendLoggerCategory } from "../../common/FrontendLoggerCategory";

export interface MeshoptDecoder {
  decodeVertexBuffer: (target: Uint8Array, count: number, size: number, source: Uint8Array, filter?: string) => void;
  decodeIndexBuffer: (target: Uint8Array, count: number, size: number, source: Uint8Array) => void;
  decodeIndexSequence: (target: Uint8Array, count: number, size: number, source: Uint8Array) => void;
  decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string): void;
};

// This is a modified version of https://github.com/zeux/meshoptimizer/blob/master/js/meshopt_decoder.js.
// The orginial code will load wasm when the module is imported, which seems to upset vitest somehow.
// This version loads wasm only when a decoder is requested, which only occurs when parsing a compressed tile.
async function getDecoder(): Promise<MeshoptDecoder | undefined> {
  // Built with clang version 16.0.0
  // Built from meshoptimizer 0.20
  const wasmBase = "b9H79Tebbbe8Fv9Gbb9Gvuuuuueu9Giuuub9Geueu9Giuuueuikqbeeedddillviebeoweuec:q;iekr;leDo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9KW9J9V9KW9wWVtW949c919M9MWVbeY9TW79O9V9Wt9F9KW9J9V9KW69U9KW949c919M9MWVbdE9TW79O9V9Wt9F9KW9J9V9KW69U9KW949tWG91W9U9JWbiL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9p9JtblK9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9r919HtbvL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWVT949Wbol79IV9Rbrq;d8Yqdbk:yzeHu8Jjjjjbcj;eb9Rgv8Kjjjjbc9:hodnadcefal0mbcuhoaiRbbc:Ge9hmbavaialfgrad9Radz1jjjbhwcj;abad9UhlaicefhodnadTmbalc;WFbGglcjdalcjd6EhDcbhqinaqae9pmeaDaeaq9RaqaDfae6Egkcsfglcl4cifcd4hxdndndndnalc9WGgmTmbcbhPcehsawcjdfhzaohHinaraH9Rax6midnaraHaxfgo9RcK6mbczhlcbhOinalgic9WfgAawcj;cbffhldndndndndnaHaAco4fRbbaOcoG4ciGPlbedibkal9cb83ibalcwf9cb83ibxikalaoRblaoRbbgAco4gCaCciSgCE86bbawcj;cbfaifglcGfaoclfaCfgCRbbaAcl4ciGgXaXciSgXE86bbalcVfaCaXfgCRbbaAcd4ciGgXaXciSgXE86bbalc7faCaXfgCRbbaAciGgAaAciSgAE86bbalctfaCaAfgCRbbaoRbegAco4gXaXciSgXE86bbalc91faCaXfgCRbbaAcl4ciGgXaXciSgXE86bbalc4faCaXfgCRbbaAcd4ciGgXaXciSgXE86bbalc93faCaXfgCRbbaAciGgAaAciSgAE86bbalc94faCaAfgCRbbaoRbdgAco4gXaXciSgXE86bbalc95faCaXfgCRbbaAcl4ciGgXaXciSgXE86bbalc96faCaXfgCRbbaAcd4ciGgXaXciSgXE86bbalc97faCaXfgCRbbaAciGgAaAciSgAE86bbalc98faCaAfgARbbaoRbigoco4gCaCciSgCE86bbalc99faAaCfgARbbaocl4ciGgCaCciSgCE86bbalc9:faAaCfgARbbaocd4ciGgCaCciSgCE86bbalcufaAaCfglRbbaociGgoaociSgoE86bbalaofhoxdkalaoRbwaoRbbgAcl4gCaCcsSgCE86bbawcj;cbfaifglcGfaocwfaCfgCRbbaAcsGgAaAcsSgAE86bbalcVfaCaAfgARbbaoRbegCcl4gXaXcsSgXE86bbalc7faAaXfgARbbaCcsGgCaCcsSgCE86bbalctfaAaCfgARbbaoRbdgCcl4gXaXcsSgXE86bbalc91faAaXfgARbbaCcsGgCaCcsSgCE86bbalc4faAaCfgARbbaoRbigCcl4gXaXcsSgXE86bbalc93faAaXfgARbbaCcsGgCaCcsSgCE86bbalc94faAaCfgARbbaoRblgCcl4gXaXcsSgXE86bbalc95faAaXfgARbbaCcsGgCaCcsSgCE86bbalc96faAaCfgARbbaoRbvgCcl4gXaXcsSgXE86bbalc97faAaXfgARbbaCcsGgCaCcsSgCE86bbalc98faAaCfgARbbaoRbogCcl4gXaXcsSgXE86bbalc99faAaXfgARbbaCcsGgCaCcsSgCE86bbalc9:faAaCfgARbbaoRbrgocl4gCaCcsSgCE86bbalcufaAaCfglRbbaocsGgoaocsSgoE86bbalaofhoxekalao8Pbb83bbalcwfaocwf8Pbb83bbaoczfhokdnaiam9pmbaOcdfhOaiczfhlarao9RcL0mekkaiam6miaoTmidnakTmbawaPfRbbhOawcj;cbfhlazhiakhAinaialRbbgHce4cbaHceG9R7aOfgO86bbaiadfhialcefhlaAcufgAmbkkazcefhzaPcefgPad6hsaohHaPad9hmexvkkcbhoasceGmdxikaoaxad2fhXdnakTmbcbhmcehsawcjdfhCinarao9Rax6miaoTmdaoaxfhoawamfRbbhOawcj;cbfhlaChiakhAinaialRbbgHce4cbaHceG9R7aOfgO86bbaiadfhialcefhlaAcufgAmbkaCcefhCamcefgmad6hsamad9hmbkaXhoxikcbhlcehsinarao9Rax6mdaoTmeaoaxfhoalcefglad6hsadal9hmbkaXhoxdkcbhoasceGTmekc9:hoxikabaqad2fawcjdfakad2z1jjjb8Aawawcjdfakcufad2fadz1jjjb8Aakaqfhqaombkc9:hoxekcbc99arao9Radcaadca0ESEhokavcj;ebf8Kjjjjbaok;xzeHu8Jjjjjbc;ae9Rgv8Kjjjjbc9:hodnaeci9UgrcHfal0mbcuhoaiRbbgwc;WeGc;Ge9hmbawcsGgDce0mbavc;abfcFecjez:jjjjb8AavcUf9cu83ibavc8Wf9cu83ibavcyf9cu83ibavcaf9cu83ibavcKf9cu83ibavczf9cu83ibav9cu83iwav9cu83ibaialfc9WfhqaicefgwarfhodnaeTmbcmcsaDceSEhkcbhxcbhmcbhrcbhicbhlindnaoaq9nmbc9:hoxikdndnawRbbgDc;Ve0mbavc;abfalaDcu7gPcl4fcsGcitfgsydlhzasydbhHdnaDcsGgDak9pmbavaiaPfcsGcdtfydbaxaDEhsaDThDdndnadcd9hmbabarcetfgPaH87ebaPcdfaz87ebaPclfas87ebxekabarcdtfgPaHBdbaPclfazBdbaPcwfasBdbkaxaDfhxavc;abfalcitfgPasBdbaPazBdlavaicdtfasBdbavc;abfalcefcsGglcitfgPaHBdbaPasBdlaiaDfhialcefhlxdkdndnaDcsSmbamaDfaDc987fcefhmxekaocefhDao8SbbgscFeGhPdndnascu9mmbaDhoxekaocvfhoaPcFbGhPcrhsdninaD8SbbgOcFbGastaPVhPaOcu9kmeaDcefhDascrfgsc8J9hmbxdkkaDcefhokaPce4cbaPceG9R7amfhmkdndnadcd9hmbabarcetfgDaH87ebaDcdfaz87ebaDclfam87ebxekabarcdtfgDaHBdbaDclfazBdbaDcwfamBdbkavc;abfalcitfgDamBdbaDazBdlavaicdtfamBdbavc;abfalcefcsGglcitfgDaHBdbaDamBdlaicefhialcefhlxekdnaDcpe0mbaxcefgOavaiaqaDcsGfRbbgscl49RcsGcdtfydbascz6gPEhDavaias9RcsGcdtfydbaOaPfgzascsGgOEhsaOThOdndnadcd9hmbabarcetfgHax87ebaHcdfaD87ebaHclfas87ebxekabarcdtfgHaxBdbaHclfaDBdbaHcwfasBdbkavaicdtfaxBdbavc;abfalcitfgHaDBdbaHaxBdlavaicefgicsGcdtfaDBdbavc;abfalcefcsGcitfgHasBdbaHaDBdlavaiaPfcsGgicdtfasBdbavc;abfalcdfcsGglcitfgDaxBdbaDasBdlalcefhlaiaOfhiazaOfhxxekaxcbaoRbbgHEgAaDc;:eSgDfhzaHcsGhCaHcl4hXdndnaHcs0mbazcefhOxekazhOavaiaX9RcsGcdtfydbhzkdndnaCmbaOcefhxxekaOhxavaiaH9RcsGcdtfydbhOkdndnaDTmbaocefhDxekaocdfhDao8SbegPcFeGhsdnaPcu9kmbaocofhAascFbGhscrhodninaD8SbbgPcFbGaotasVhsaPcu9kmeaDcefhDaocrfgoc8J9hmbkaAhDxekaDcefhDkasce4cbasceG9R7amfgmhAkdndnaXcsSmbaDhsxekaDcefhsaD8SbbgocFeGhPdnaocu9kmbaDcvfhzaPcFbGhPcrhodninas8SbbgDcFbGaotaPVhPaDcu9kmeascefhsaocrfgoc8J9hmbkazhsxekascefhskaPce4cbaPceG9R7amfgmhzkdndnaCcsSmbashoxekascefhoas8SbbgDcFeGhPdnaDcu9kmbascvfhOaPcFbGhPcrhDdninao8SbbgscFbGaDtaPVhPascu9kmeaocefhoaDcrfgDc8J9hmbkaOhoxekaocefhokaPce4cbaPceG9R7amfgmhOkdndnadcd9hmbabarcetfgDaA87ebaDcdfaz87ebaDclfaO87ebxekabarcdtfgDaABdbaDclfazBdbaDcwfaOBdbkavc;abfalcitfgDazBdbaDaABdlavaicdtfaABdbavc;abfalcefcsGcitfgDaOBdbaDazBdlavaicefgicsGcdtfazBdbavc;abfalcdfcsGcitfgDaABdbaDaOBdlavaiaHcz6aXcsSVfgicsGcdtfaOBdbaiaCTaCcsSVfhialcifhlkawcefhwalcsGhlaicsGhiarcifgrae6mbkkcbc99aoaqSEhokavc;aef8Kjjjjbaok:flevu8Jjjjjbcz9Rhvc9:hodnaecvfal0mbcuhoaiRbbc;:eGc;qe9hmbav9cb83iwaicefhraialfc98fhwdnaeTmbdnadcdSmbcbhDindnaraw6mbc9:skarcefhoar8SbbglcFeGhidndnalcu9mmbaohrxekarcvfhraicFbGhicrhldninao8SbbgdcFbGaltaiVhiadcu9kmeaocefhoalcrfglc8J9hmbxdkkaocefhrkabaDcdtfaic8Etc8F91aicd47avcwfaiceGcdtVgoydbfglBdbaoalBdbaDcefgDae9hmbxdkkcbhDindnaraw6mbc9:skarcefhoar8SbbglcFeGhidndnalcu9mmbaohrxekarcvfhraicFbGhicrhldninao8SbbgdcFbGaltaiVhiadcu9kmeaocefhoalcrfglc8J9hmbxdkkaocefhrkabaDcetfaic8Etc8F91aicd47avcwfaiceGcdtVgoydbfgl87ebaoalBdbaDcefgDae9hmbkkcbc99arawSEhokaok:Lvoeue99dud99eud99dndnadcl9hmbaeTmeindndnabcdfgd8Sbb:Yab8Sbbgi:Ygl:l:tabcefgv8Sbbgo:Ygr:l:tgwJbb;:9cawawNJbbbbawawJbbbb9GgDEgq:mgkaqaicb9iEalMgwawNakaqaocb9iEarMgqaqNMM:r:vglNJbbbZJbbb:;aDEMgr:lJbbb9p9DTmbar:Ohixekcjjjj94hikadai86bbdndnaqalNJbbbZJbbb:;aqJbbbb9GEMgq:lJbbb9p9DTmbaq:Ohdxekcjjjj94hdkavad86bbdndnawalNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohdxekcjjjj94hdkabad86bbabclfhbaecufgembxdkkaeTmbindndnabclfgd8Ueb:Yab8Uebgi:Ygl:l:tabcdfgv8Uebgo:Ygr:l:tgwJb;:FSawawNJbbbbawawJbbbb9GgDEgq:mgkaqaicb9iEalMgwawNakaqaocb9iEarMgqaqNMM:r:vglNJbbbZJbbb:;aDEMgr:lJbbb9p9DTmbar:Ohixekcjjjj94hikadai87ebdndnaqalNJbbbZJbbb:;aqJbbbb9GEMgq:lJbbb9p9DTmbaq:Ohdxekcjjjj94hdkavad87ebdndnawalNJbbbZJbbb:;awJbbbb9GEMgw:lJbbb9p9DTmbaw:Ohdxekcjjjj94hdkabad87ebabcwfhbaecufgembkkk;siliui99iue99dnaeTmbcbhiabhlindndnJ;Zl81Zalcof8UebgvciV:Y:vgoal8Ueb:YNgrJb;:FSNJbbbZJbbb:;arJbbbb9GEMgw:lJbbb9p9DTmbaw:OhDxekcjjjj94hDkalclf8Uebhqalcdf8UebhkabaiavcefciGfcetfaD87ebdndnaoak:YNgwJb;:FSNJbbbZJbbb:;awJbbbb9GEMgx:lJbbb9p9DTmbax:Ohkxekcjjjj94hkkabaiavcdfciGfcetfak87ebdndnaoaq:YNgoJb;:FSNJbbbZJbbb:;aoJbbbb9GEMgx:lJbbb9p9DTmbax:Ohqxekcjjjj94hqkabaiavcufciGfcetfaq87ebdndnJbbjZararN:tawawN:taoaoN:tgrJbbbbarJbbbb9GE:rJb;:FSNJbbbZMgr:lJbbb9p9DTmbar:Ohqxekcjjjj94hqkabaiavciGfcetfaq87ebalcwfhlaiclfhiaecufgembkkk9mbdnadcd4ae2gdTmbinababydbgecwtcw91:Yaece91cjjj98Gcjjj;8if::NUdbabclfhbadcufgdmbkkk9teiucbcbydj1jjbgeabcifc98GfgbBdj1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaik;LeeeudndnaeabVciGTmbabhixekdndnadcz9pmbabhixekabhiinaiaeydbBdbaiclfaeclfydbBdbaicwfaecwfydbBdbaicxfaecxfydbBdbaeczfheaiczfhiadc9Wfgdcs0mbkkadcl6mbinaiaeydbBdbaeclfheaiclfhiadc98fgdci0mbkkdnadTmbinaiaeRbb86bbaicefhiaecefheadcufgdmbkkabk;aeedudndnabciGTmbabhixekaecFeGc:b:c:ew2hldndnadcz9pmbabhixekabhiinaialBdbaicxfalBdbaicwfalBdbaiclfalBdbaiczfhiadc9Wfgdcs0mbkkadcl6mbinaialBdbaiclfhiadc98fgdci0mbkkdnadTmbinaiae86bbaicefhiadcufgdmbkkabkkkebcjwklz9Kbb";
  const wasmSimd = "b9H79TebbbeKl9Gbb9Gvuuuuueu9Giuuub9Geueuikqbbebeedddilve9Weeeviebeoweuec:q;Aekr;leDo9TW9T9VV95dbH9F9F939H79T9F9J9H229F9Jt9VV7bb8A9TW79O9V9Wt9F9KW9J9V9KW9wWVtW949c919M9MWVbdY9TW79O9V9Wt9F9KW9J9V9KW69U9KW949c919M9MWVblE9TW79O9V9Wt9F9KW9J9V9KW69U9KW949tWG91W9U9JWbvL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9p9JtboK9TW79O9V9Wt9F9KW9J9V9KWS9P2tWV9r919HtbrL9TW79O9V9Wt9F9KW9J9V9KWS9P2tWVT949Wbwl79IV9RbDq;b9tqlbzik9:evu8Jjjjjbcz9Rhbcbheincbhdcbhiinabcwfadfaicjuaead4ceGglE86bbaialfhiadcefgdcw9hmbkaec:q:yjjbfai86bbaecitc:q1jjbfab8Piw83ibaecefgecjd9hmbkk;e8JlHud97euo978Jjjjjbcj;kb9Rgv8Kjjjjbc9:hodnadcefal0mbcuhoaiRbbc:Ge9hmbavaialfgrad9Rad;8qbbcj;abad9UhoaicefhldnadTmbaoc;WFbGgocjdaocjd6EhwcbhDinaDae9pmeawaeaD9RaDawfae6Egqcsfgoc9WGgkci2hxakcethmaocl4cifcd4hPabaDad2fhscbhzdnincbhHalhOcbhAdninaraO9RaP6miavcj;cbfaAak2fhCaOaPfhlcbhidnakc;ab6mbaral9Rc;Gb6mbcbhoinaCaofhidndndndndnaOaoco4fRbbgXciGPlbedibkaipxbbbbbbbbbbbbbbbbpklbxikaialpbblalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLgQcdp:meaQpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9ogLpxiiiiiiiiiiiiiiiip8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklbalclfaYpQbfaKc:q:yjjbfRbbfhlxdkaialpbbwalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9ogLpxssssssssssssssssp8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklbalcwfaYpQbfaKc:q:yjjbfRbbfhlxekaialpbbbpklbalczfhlkdndndndndnaXcd4ciGPlbedibkaipxbbbbbbbbbbbbbbbbpklzxikaialpbblalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLgQcdp:meaQpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9ogLpxiiiiiiiiiiiiiiiip8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklzalclfaYpQbfaKc:q:yjjbfRbbfhlxdkaialpbbwalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9ogLpxssssssssssssssssp8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklzalcwfaYpQbfaKc:q:yjjbfRbbfhlxekaialpbbbpklzalczfhlkdndndndndnaXcl4ciGPlbedibkaipxbbbbbbbbbbbbbbbbpklaxikaialpbblalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLgQcdp:meaQpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9ogLpxiiiiiiiiiiiiiiiip8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklaalclfaYpQbfaKc:q:yjjbfRbbfhlxdkaialpbbwalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9ogLpxssssssssssssssssp8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklaalcwfaYpQbfaKc:q:yjjbfRbbfhlxekaialpbbbpklaalczfhlkdndndndndnaXco4Plbedibkaipxbbbbbbbbbbbbbbbbpkl8WxikaialpbblalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLgQcdp:meaQpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9ogLpxiiiiiiiiiiiiiiiip8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgXcitc:q1jjbfpbibaXc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgXcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spkl8WalclfaYpQbfaXc:q:yjjbfRbbfhlxdkaialpbbwalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9ogLpxssssssssssssssssp8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgXcitc:q1jjbfpbibaXc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgXcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spkl8WalcwfaYpQbfaXc:q:yjjbfRbbfhlxekaialpbbbpkl8Walczfhlkaoc;abfhiaocjefak0meaihoaral9Rc;Fb0mbkkdndnaiak9pmbaici4hoinaral9RcK6mdaCaifhXdndndndndnaOaico4fRbbaocoG4ciGPlbedibkaXpxbbbbbbbbbbbbbbbbpklbxikaXalpbblalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLgQcdp:meaQpmbzeHdOiAlCvXoQrLpxiiiiiiiiiiiiiiiip9ogLpxiiiiiiiiiiiiiiiip8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklbalclfaYpQbfaKc:q:yjjbfRbbfhlxdkaXalpbbwalpbbbgQclp:meaQpmbzeHdOiAlCvXoQrLpxssssssssssssssssp9ogLpxssssssssssssssssp8JgQp5b9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibaKc:q:yjjbfpbbbgYaYpmbbbbbbbbbbbbbbbbaQp5e9cjF;8;4;W;G;ab9:9cU1:NgKcitc:q1jjbfpbibp9UpmbedilvorzHOACXQLpPaLaQp9spklbalcwfaYpQbfaKc:q:yjjbfRbbfhlxekaXalpbbbpklbalczfhlkaocdfhoaiczfgiak6mbkkalTmbaAcd0hHalhOaAcefgAclSmdxekkcbhlaHceGTmdkdnakTmbavcjdfazfhiavazfpbdbhYcbhXinaiavcj;cbfaXfgopblbgLcep9TaLpxeeeeeeeeeeeeeeeegQp9op9Hp9rgLaoakfpblbg8Acep9Ta8AaQp9op9Hp9rg8ApmbzeHdOiAlCvXoQrLgEaoamfpblbg3cep9Ta3aQp9op9Hp9rg3aoaxfpblbg5cep9Ta5aQp9op9Hp9rg5pmbzeHdOiAlCvXoQrLg8EpmbezHdiOAlvCXorQLgQaQpmbedibedibedibediaYp9UgYp9AdbbaiadfgoaYaQaQpmlvorlvorlvorlvorp9UgYp9AdbbaoadfgoaYaQaQpmwDqkwDqkwDqkwDqkp9UgYp9AdbbaoadfgoaYaQaQpmxmPsxmPsxmPsxmPsp9UgYp9AdbbaoadfgoaYaEa8EpmwDKYqk8AExm35Ps8E8FgQaQpmbedibedibedibedip9UgYp9AdbbaoadfgoaYaQaQpmlvorlvorlvorlvorp9UgYp9AdbbaoadfgoaYaQaQpmwDqkwDqkwDqkwDqkp9UgYp9AdbbaoadfgoaYaQaQpmxmPsxmPsxmPsxmPsp9UgYp9AdbbaoadfgoaYaLa8ApmwKDYq8AkEx3m5P8Es8FgLa3a5pmwKDYq8AkEx3m5P8Es8Fg8ApmbezHdiOAlvCXorQLgQaQpmbedibedibedibedip9UgYp9AdbbaoadfgoaYaQaQpmlvorlvorlvorlvorp9UgYp9AdbbaoadfgoaYaQaQpmwDqkwDqkwDqkwDqkp9UgYp9AdbbaoadfgoaYaQaQpmxmPsxmPsxmPsxmPsp9UgYp9AdbbaoadfgoaYaLa8ApmwDKYqk8AExm35Ps8E8FgQaQpmbedibedibedibedip9UgYp9AdbbaoadfgoaYaQaQpmlvorlvorlvorlvorp9UgYp9AdbbaoadfgoaYaQaQpmwDqkwDqkwDqkwDqkp9UgYp9AdbbaoadfgoaYaQaQpmxmPsxmPsxmPsxmPsp9UgYp9AdbbaoadfhiaXczfgXak6mbkkazclfgzad6mbkasavcjdfaqad2;8qbbavavcjdfaqcufad2fad;8qbbaqaDfhDc9:hoalmexikkc9:hoxekcbc99aral9Radcaadca0ESEhokavcj;kbf8Kjjjjbaokwbz:bjjjbk;tzeHu8Jjjjjbc;ae9Rgv8Kjjjjbc9:hodnaeci9UgrcHfal0mbcuhoaiRbbgwc;WeGc;Ge9hmbawcsGgDce0mbavc;abfcFecje;8kbavcUf9cu83ibavc8Wf9cu83ibavcyf9cu83ibavcaf9cu83ibavcKf9cu83ibavczf9cu83ibav9cu83iwav9cu83ibaialfc9WfhqaicefgwarfhodnaeTmbcmcsaDceSEhkcbhxcbhmcbhrcbhicbhlindnaoaq9nmbc9:hoxikdndnawRbbgDc;Ve0mbavc;abfalaDcu7gPcl4fcsGcitfgsydlhzasydbhHdnaDcsGgDak9pmbavaiaPfcsGcdtfydbaxaDEhsaDThDdndnadcd9hmbabarcetfgPaH87ebaPcdfaz87ebaPclfas87ebxekabarcdtfgPaHBdbaPclfazBdbaPcwfasBdbkaxaDfhxavc;abfalcitfgPasBdbaPazBdlavaicdtfasBdbavc;abfalcefcsGglcitfgPaHBdbaPasBdlaiaDfhialcefhlxdkdndnaDcsSmbamaDfaDc987fcefhmxekaocefhDao8SbbgscFeGhPdndnascu9mmbaDhoxekaocvfhoaPcFbGhPcrhsdninaD8SbbgOcFbGastaPVhPaOcu9kmeaDcefhDascrfgsc8J9hmbxdkkaDcefhokaPce4cbaPceG9R7amfhmkdndnadcd9hmbabarcetfgDaH87ebaDcdfaz87ebaDclfam87ebxekabarcdtfgDaHBdbaDclfazBdbaDcwfamBdbkavc;abfalcitfgDamBdbaDazBdlavaicdtfamBdbavc;abfalcefcsGglcitfgDaHBdbaDamBdlaicefhialcefhlxekdnaDcpe0mbaxcefgOavaiaqaDcsGfRbbgscl49RcsGcdtfydbascz6gPEhDavaias9RcsGcdtfydbaOaPfgzascsGgOEhsaOThOdndnadcd9hmbabarcetfgHax87ebaHcdfaD87ebaHclfas87ebxekabarcdtfgHaxBdbaHclfaDBdbaHcwfasBdbkavaicdtfaxBdbavc;abfalcitfgHaDBdbaHaxBdlavaicefgicsGcdtfaDBdbavc;abfalcefcsGcitfgHasBdbaHaDBdlavaiaPfcsGgicdtfasBdbavc;abfalcdfcsGglcitfgDaxBdbaDasBdlalcefhlaiaOfhiazaOfhxxekaxcbaoRbbgHEgAaDc;:eSgDfhzaHcsGhCaHcl4hXdndnaHcs0mbazcefhOxekazhOavaiaX9RcsGcdtfydbhzkdndnaCmbaOcefhxxekaOhxavaiaH9RcsGcdtfydbhOkdndnaDTmbaocefhDxekaocdfhDao8SbegPcFeGhsdnaPcu9kmbaocofhAascFbGhscrhodninaD8SbbgPcFbGaotasVhsaPcu9kmeaDcefhDaocrfgoc8J9hmbkaAhDxekaDcefhDkasce4cbasceG9R7amfgmhAkdndnaXcsSmbaDhsxekaDcefhsaD8SbbgocFeGhPdnaocu9kmbaDcvfhzaPcFbGhPcrhodninas8SbbgDcFbGaotaPVhPaDcu9kmeascefhsaocrfgoc8J9hmbkazhsxekascefhskaPce4cbaPceG9R7amfgmhzkdndnaCcsSmbashoxekascefhoas8SbbgDcFeGhPdnaDcu9kmbascvfhOaPcFbGhPcrhDdninao8SbbgscFbGaDtaPVhPascu9kmeaocefhoaDcrfgDc8J9hmbkaOhoxekaocefhokaPce4cbaPceG9R7amfgmhOkdndnadcd9hmbabarcetfgDaA87ebaDcdfaz87ebaDclfaO87ebxekabarcdtfgDaABdbaDclfazBdbaDcwfaOBdbkavc;abfalcitfgDazBdbaDaABdlavaicdtfaABdbavc;abfalcefcsGcitfgDaOBdbaDazBdlavaicefgicsGcdtfazBdbavc;abfalcdfcsGcitfgDaABdbaDaOBdlavaiaHcz6aXcsSVfgicsGcdtfaOBdbaiaCTaCcsSVfhialcifhlkawcefhwalcsGhlaicsGhiarcifgrae6mbkkcbc99aoaqSEhokavc;aef8Kjjjjbaok:flevu8Jjjjjbcz9Rhvc9:hodnaecvfal0mbcuhoaiRbbc;:eGc;qe9hmbav9cb83iwaicefhraialfc98fhwdnaeTmbdnadcdSmbcbhDindnaraw6mbc9:skarcefhoar8SbbglcFeGhidndnalcu9mmbaohrxekarcvfhraicFbGhicrhldninao8SbbgdcFbGaltaiVhiadcu9kmeaocefhoalcrfglc8J9hmbxdkkaocefhrkabaDcdtfaic8Etc8F91aicd47avcwfaiceGcdtVgoydbfglBdbaoalBdbaDcefgDae9hmbxdkkcbhDindnaraw6mbc9:skarcefhoar8SbbglcFeGhidndnalcu9mmbaohrxekarcvfhraicFbGhicrhldninao8SbbgdcFbGaltaiVhiadcu9kmeaocefhoalcrfglc8J9hmbxdkkaocefhrkabaDcetfaic8Etc8F91aicd47avcwfaiceGcdtVgoydbfgl87ebaoalBdbaDcefgDae9hmbkkcbc99arawSEhokaok:wPliuo97eue978Jjjjjbca9Rhiaec98Ghldndnadcl9hmbdnalTmbcbhvabhdinadadpbbbgocKp:RecKp:Sep;6egraocwp:RecKp:Sep;6earp;Geaoczp:RecKp:Sep;6egwp;Gep;Kep;LegDpxbbbbbbbbbbbbbbbbp:2egqarpxbbbjbbbjbbbjbbbjgkp9op9rp;Kegrpxbb;:9cbb;:9cbb;:9cbb;:9cararp;MeaDaDp;Meawaqawakp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFbbbFbbbFbbbFbbbp9oaopxbbbFbbbFbbbFbbbFp9op9qarawp;Meaqp;Kecwp:RepxbFbbbFbbbFbbbFbbp9op9qaDawp;Meaqp;Keczp:RepxbbFbbbFbbbFbbbFbp9op9qpkbbadczfhdavclfgval6mbkkalae9pmeaipxbbbbbbbbbbbbbbbbgqpklbaiabalcdtfgdaeciGglcdtgv;8qbbdnalTmbaiaipblbgocKp:RecKp:Sep;6egraocwp:RecKp:Sep;6earp;Geaoczp:RecKp:Sep;6egwp;Gep;Kep;LegDaqp:2egqarpxbbbjbbbjbbbjbbbjgkp9op9rp;Kegrpxbb;:9cbb;:9cbb;:9cbb;:9cararp;MeaDaDp;Meawaqawakp9op9rp;Kegrarp;Mep;Kep;Kep;Jep;Negwp;Mepxbbn0bbn0bbn0bbn0gqp;KepxFbbbFbbbFbbbFbbbp9oaopxbbbFbbbFbbbFbbbFp9op9qarawp;Meaqp;Kecwp:RepxbFbbbFbbbFbbbFbbp9op9qaDawp;Meaqp;Keczp:RepxbbFbbbFbbbFbbbFbp9op9qpklbkadaiav;8qbbskdnalTmbcbhvabhdinadczfgxaxpbbbgopxbbbbbbFFbbbbbbFFgkp9oadpbbbgDaopmlvorxmPsCXQL358E8FpxFubbFubbFubbFubbp9op;6eaDaopmbediwDqkzHOAKY8AEgoczp:Sep;6egrp;Geaoczp:Reczp:Sep;6egwp;Gep;Kep;Legopxb;:FSb;:FSb;:FSb;:FSawaopxbbbbbbbbbbbbbbbbp:2egqawpxbbbjbbbjbbbjbbbjgmp9op9rp;Kegwawp;Meaoaop;Mearaqaramp9op9rp;Kegoaop;Mep;Kep;Kep;Jep;Negrp;Mepxbbn0bbn0bbn0bbn0gqp;Keczp:Reawarp;Meaqp;KepxFFbbFFbbFFbbFFbbp9op9qgwaoarp;Meaqp;KepxFFbbFFbbFFbbFFbbp9ogopmwDKYqk8AExm35Ps8E8Fp9qpkbbadaDakp9oawaopmbezHdiOAlvCXorQLp9qpkbbadcafhdavclfgval6mbkkalae9pmbaiaeciGgvcitgdfcbcaad9R;8kbaiabalcitfglad;8qbbdnavTmbaiaipblzgopxbbbbbbFFbbbbbbFFgkp9oaipblbgDaopmlvorxmPsCXQL358E8FpxFubbFubbFubbFubbp9op;6eaDaopmbediwDqkzHOAKY8AEgoczp:Sep;6egrp;Geaoczp:Reczp:Sep;6egwp;Gep;Kep;Legopxb;:FSb;:FSb;:FSb;:FSawaopxbbbbbbbbbbbbbbbbp:2egqawpxbbbjbbbjbbbjbbbjgmp9op9rp;Kegwawp;Meaoaop;Mearaqaramp9op9rp;Kegoaop;Mep;Kep;Kep;Jep;Negrp;Mepxbbn0bbn0bbn0bbn0gqp;Keczp:Reawarp;Meaqp;KepxFFbbFFbbFFbbFFbbp9op9qgwaoarp;Meaqp;KepxFFbbFFbbFFbbFFbbp9ogopmwDKYqk8AExm35Ps8E8Fp9qpklzaiaDakp9oawaopmbezHdiOAlvCXorQLp9qpklbkalaiad;8qbbkk;4wllue97euv978Jjjjjbc8W9Rhidnaec98GglTmbcbhvabhoinaiaopbbbgraoczfgwpbbbgDpmlvorxmPsCXQL358E8Fgqczp:Segkclp:RepklbaopxbbjZbbjZbbjZbbjZpx;Zl81Z;Zl81Z;Zl81Z;Zl81Zakpxibbbibbbibbbibbbp9qp;6ep;NegkaraDpmbediwDqkzHOAKY8AEgrczp:Reczp:Sep;6ep;MegDaDp;Meakarczp:Sep;6ep;Megxaxp;Meakaqczp:Reczp:Sep;6ep;Megqaqp;Mep;Kep;Kep;Lepxbbbbbbbbbbbbbbbbp:4ep;Jepxb;:FSb;:FSb;:FSb;:FSgkp;Mepxbbn0bbn0bbn0bbn0grp;KepxFFbbFFbbFFbbFFbbgmp9oaxakp;Mearp;Keczp:Rep9qgxaqakp;Mearp;Keczp:ReaDakp;Mearp;Keamp9op9qgkpmbezHdiOAlvCXorQLgrp5baipblbpEb:T:j83ibaocwfarp5eaipblbpEe:T:j83ibawaxakpmwDKYqk8AExm35Ps8E8Fgkp5baipblbpEd:T:j83ibaocKfakp5eaipblbpEi:T:j83ibaocafhoavclfgval6mbkkdnalae9pmbaiaeciGgvcitgofcbcaao9R;8kbaiabalcitfgwao;8qbbdnavTmbaiaipblbgraipblzgDpmlvorxmPsCXQL358E8Fgqczp:Segkclp:RepklaaipxbbjZbbjZbbjZbbjZpx;Zl81Z;Zl81Z;Zl81Z;Zl81Zakpxibbbibbbibbbibbbp9qp;6ep;NegkaraDpmbediwDqkzHOAKY8AEgrczp:Reczp:Sep;6ep;MegDaDp;Meakarczp:Sep;6ep;Megxaxp;Meakaqczp:Reczp:Sep;6ep;Megqaqp;Mep;Kep;Kep;Lepxbbbbbbbbbbbbbbbbp:4ep;Jepxb;:FSb;:FSb;:FSb;:FSgkp;Mepxbbn0bbn0bbn0bbn0grp;KepxFFbbFFbbFFbbFFbbgmp9oaxakp;Mearp;Keczp:Rep9qgxaqakp;Mearp;Keczp:ReaDakp;Mearp;Keamp9op9qgkpmbezHdiOAlvCXorQLgrp5baipblapEb:T:j83ibaiarp5eaipblapEe:T:j83iwaiaxakpmwDKYqk8AExm35Ps8E8Fgkp5baipblapEd:T:j83izaiakp5eaipblapEi:T:j83iKkawaiao;8qbbkk:Pddiue978Jjjjjbc;ab9Rhidnadcd4ae2glc98GgvTmbcbheabhdinadadpbbbgocwp:Recwp:Sep;6eaocep:SepxbbjFbbjFbbjFbbjFp9opxbbjZbbjZbbjZbbjZp:Uep;Mepkbbadczfhdaeclfgeav6mbkkdnaval9pmbaialciGgecdtgdVcbc;abad9R;8kbaiabavcdtfgvad;8qbbdnaeTmbaiaipblbgocwp:Recwp:Sep;6eaocep:SepxbbjFbbjFbbjFbbjFp9opxbbjZbbjZbbjZbbjZp:Uep;Mepklbkavaiad;8qbbkk9teiucbcbydj1jjbgeabcifc98GfgbBdj1jjbdndnabZbcztgd9nmbcuhiabad9RcFFifcz4nbcuSmekaehikaikkkebcjwklz9Tbb";

  const detector = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 3, 2, 0, 0, 5, 3, 1, 0, 1, 12, 1, 0, 10, 22, 2, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11, 7, 0, 65, 0, 253, 15, 26, 11]);
  const wasmpack = new Uint8Array([32, 0, 65, 2, 1, 106, 34, 33, 3, 128, 11, 4, 13, 64, 6, 253, 10, 7, 15, 116, 127, 5, 8, 12, 40, 16, 19, 54, 20, 9, 27, 255, 113, 17, 42, 67, 24, 23, 146, 148, 18, 14, 22, 45, 70, 69, 56, 114, 101, 21, 25, 63, 75, 136, 108, 28, 118, 29, 73, 115]);

  if (typeof WebAssembly !== 'object') {
    Logger.logError(FrontendLoggerCategory.Render, "WebAssembly is not supported in this environment");
    return undefined;
  }

  const wasm = WebAssembly.validate(detector) ? unpack(wasmSimd) : unpack(wasmBase);

  let instance: any;

  try {
    const result = await WebAssembly.instantiate(wasm, {});
    instance = result.instance;
    instance.exports.__wasm_call_ctors();
  }
  catch (err) {
    Logger.logException(FrontendLoggerCategory.Render, err);
    return undefined;
  }

  function unpack(data: string) {
    const result = new Uint8Array(data.length);
    for (let i = 0; i < data.length; ++i) {
      const ch = data.charCodeAt(i);
      result[i] = ch > 96 ? ch - 97 : ch > 64 ? ch - 39 : ch + 4;
    }
    let write = 0;
    for (let i = 0; i < data.length; ++i) {
      result[write++] = (result[i] < 60) ? wasmpack[result[i]] : (result[i] - 60) * 64 + result[++i];
    }
    return result.buffer.slice(0, write);
  }

  function decode(decoder: string, target: Uint8Array, count: number, size: number, source: Uint8Array, filter?: any) {
    const fun = instance.exports[decoder];
    const sbrk = instance.exports.sbrk;
    const count4 = (count + 3) & ~3;
    const tp = sbrk(count4 * size);
    const sp = sbrk(source.length);
    const heap = new Uint8Array(instance.exports.memory.buffer);
    heap.set(source, sp);
    const res = fun(tp, count, size, sp, source.length);
    if (res === 0 && filter) {
      filter(tp, count4, size);
    }
    target.set(heap.subarray(tp, tp + count * size));
    sbrk(tp - sbrk(0));
    if (res !== 0) {
      throw new Error(`Malformed buffer data: ${res}`);
    }
  }

  const decoders: any = {
    //eslint-disable-next-line @typescript-eslint/naming-convention
    ATTRIBUTES: 'meshopt_decodeVertexBuffer',
    //eslint-disable-next-line @typescript-eslint/naming-convention
    TRIANGLES: 'meshopt_decodeIndexBuffer',
    //eslint-disable-next-line @typescript-eslint/naming-convention
    INDICES: 'meshopt_decodeIndexSequence',
  };

  const filters: any = {
    //eslint-disable-next-line @typescript-eslint/naming-convention
    NONE: '',
    //eslint-disable-next-line @typescript-eslint/naming-convention
    OCTAHEDRAL: 'meshopt_decodeFilterOct',
    //eslint-disable-next-line @typescript-eslint/naming-convention
    QUATERNION: 'meshopt_decodeFilterQuat',
    //eslint-disable-next-line @typescript-eslint/naming-convention
    EXPONENTIAL: 'meshopt_decodeFilterExp',
  };

  return {
    decodeVertexBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, filter?: string) {
      decode(decoders.ATTRIBUTES, target, count, size, source, filter ? instance.exports[filters[filter]] : undefined);
    },
    decodeIndexBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array) {
      decode(decoders.TRIANGLES, target, count, size, source);
    },
    decodeIndexSequence(target: Uint8Array, count: number, size: number, source: Uint8Array) {
      decode(decoders.INDICES, target, count, size, source);
    },
    decodeGltfBuffer(target: Uint8Array, count: number, size: number, source: Uint8Array, mode: string, filter?: string) {
      decode(decoders[mode], target, count, size, source, filter ? instance.exports[filters[filter]] : undefined);
    },
  };
};

let meshoptDecoderLoaded: boolean = false;
let meshoptDecoder: MeshoptDecoder | undefined;

export async function getMeshoptDecoder(): Promise<MeshoptDecoder | undefined> {
  if (!meshoptDecoderLoaded) {
    meshoptDecoder = await getDecoder();
    meshoptDecoderLoaded = true;
  }
  return meshoptDecoder;
}

/** Arguments supplied to decodeMeshoptBuffer.
 */
export interface DecodeMeshoptBufferArgs {
  byteStride: number;
  count: number;
  mode: ExtMeshoptCompressionMode;
  filter?: ExtMeshoptCompressionFilter;
}

export async function decodeMeshoptBuffer(source: Uint8Array, args: DecodeMeshoptBufferArgs): Promise<Uint8Array | undefined> {
  const decoder = await getMeshoptDecoder();
  if (!decoder) {
    return undefined;
  }

  const target = new Uint8Array(args.count * args.byteStride);
  decoder.decodeGltfBuffer(target, args.count, args.byteStride, source, args.mode, args.filter);
  return target;
}
